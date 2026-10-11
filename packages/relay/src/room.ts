/**
 * In-memory rooms and WebRTC signalling routing, transport-agnostic so the
 * socket binding (server.ts) and the relay dispatcher (relay.ts) can stay
 * thin. Semantics: docs/03-netplay-protocol.md, docs/contracts/ws-messages.md.
 */
import {
  PLAYER_SLOTS,
  decodeInput,
  encodeInput,
  type GameEnd,
  type GameSet,
  type GameStart,
  type HashMessage,
  type InputLog,
  type InputPacket,
  type PlayerReady,
  type RoomState,
  type RtcSignal,
  type ViewerSnapshot,
  type ViewerState,
} from "@wma/protocol";
import { InputLogRecorder } from "./input-log.ts";
import type { TokenVerifier } from "./token.ts";

export type Role = "player" | "viewer";

/** Room lifecycle: `waiting` pre-game, `playing` after the host's game.start. */
export type RoomStatus = "waiting" | "playing" | "ended";

export interface RoomMember {
  connectionId: string;
  sub: string;
  name: string;
  role: Role;
  /** Player slot 0-3, or null for viewers. */
  slot: number | null;
  /** Lobby ready flag; false until the player toggles it (T27). */
  ready: boolean;
}

export interface JoinRequest {
  room: string;
  role: Role;
  token: string;
}

/** Room rule violation; `code` maps to the relay `error` message code. */
export class RelayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
  }
}

/** The match identity a host sets with `game.set` (T30, docs/contracts). */
export interface RoomGame {
  driver: string;
  coreHash: string;
  mameCommit: string;
  romHash: string;
  dips: Record<string, string | number>;
}

interface Room {
  id: string;
  members: Map<string, RoomMember>;
  status: RoomStatus;
  start: { startFrame: number; inputDelay: number } | null;
  /** Host-set game identity, or null until `game.set` (T30). */
  game: RoomGame | null;
  /** Open input log for the current match, or null (T30). */
  log: InputLogRecorder | null;
  /** Latest host live-join snapshot: the viewer's start point (T31). */
  snapshot: { frame: number; blobUrl: string } | null;
  /** Frame the hash comparison is currently on (T25), or -1 before any hash. */
  hashFrame: number;
  /** This frame's crc32 per player slot; reset whenever a newer frame arrives. */
  hashes: Map<number, number>;
}

/** Outcome of a `hash` message; `mismatch` triggers a `desync` broadcast. */
export interface HashResult {
  roomId: string;
  slot: number;
  frame: number;
  mismatch: boolean;
}

/** The lowest occupied player slot in a room (its host), or null if none. */
function lowestSlot(room: Room): number | null {
  const slots = [...room.members.values()]
    .map((m) => m.slot)
    .filter((slot): slot is number => slot !== null);
  return slots.length > 0 ? Math.min(...slots) : null;
}

/** Seated players in slot order, for the input-log start roster (T30). */
function seatedPlayers(room: Room): { slot: number; name: string }[] {
  return [...room.members.values()]
    .filter((m): m is RoomMember & { slot: number } => m.slot !== null)
    .sort((a, b) => a.slot - b.slot)
    .map((m) => ({ slot: m.slot, name: m.name }));
}

/**
 * Largest frame advance accepted between hash comparisons (T25), and the
 * farthest a hash frame may sit from the room's start. Legitimate hashes
 * advance ~60 per report; the window (one hour of frames) tolerates a long
 * stall yet rejects an absurd frame that would strand the comparison far ahead
 * of the real game clock. Note a peer can always *suppress* detection by simply
 * not reporting; that is the verifier/anti-cheat's job (T33/T36), not the relay.
 */
const MAX_HASH_FRAME_JUMP = 60 * 60 * 60;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly byConnection = new Map<string, string>();
  private readonly verifier: TokenVerifier;

  constructor(verifier: TokenVerifier) {
    this.verifier = verifier;
  }

  /** Verify the token and seat the connection. Throws TokenError/RelayError. */
  join(connectionId: string, request: JoinRequest): RoomMember {
    const claims = this.verifier.verify(request.token);
    const name = claims.name ?? "player";

    const currentRoom = this.byConnection.get(connectionId);
    if (currentRoom !== undefined && currentRoom !== request.room) {
      throw new RelayError(
        "already_joined",
        `connection is already in room ${currentRoom}`,
      );
    }

    const room = this.ensureRoom(request.room);

    const sameConnection = room.members.get(connectionId);
    if (sameConnection) {
      if (sameConnection.role === request.role) {
        sameConnection.name = name;
        return sameConnection;
      }
      // Role change on a live connection: allocate before mutating so a
      // rejection (room_full) leaves the existing membership intact.
      const slot =
        request.role === "player"
          ? (sameConnection.slot ?? this.freeSlot(room))
          : null;
      sameConnection.name = name;
      sameConnection.role = request.role;
      sameConnection.slot = slot;
      sameConnection.ready = false;
      return sameConnection;
    }

    // Same user reconnecting on a new socket: reattach in place, preserving the
    // existing slot when the role is unchanged. Allocate before mutating so a
    // rejected role switch (room_full) does not drop the prior membership.
    const reconnect = [...room.members.values()].find((m) => m.sub === claims.sub);
    if (reconnect) {
      const slot =
        request.role === "player" ? (reconnect.slot ?? this.freeSlot(room)) : null;
      room.members.delete(reconnect.connectionId);
      this.byConnection.delete(reconnect.connectionId);
      const member: RoomMember = {
        connectionId,
        sub: claims.sub,
        name,
        role: request.role,
        slot,
        ready: reconnect.ready,
      };
      room.members.set(connectionId, member);
      this.byConnection.set(connectionId, room.id);
      return member;
    }

    const slot = request.role === "player" ? this.freeSlot(room) : null;
    const member: RoomMember = {
      connectionId,
      sub: claims.sub,
      name,
      role: request.role,
      slot,
      ready: false,
    };
    room.members.set(connectionId, member);
    this.byConnection.set(connectionId, room.id);
    return member;
  }

  /** Remove a connection; returns the room id it was in, if any. */
  leave(connectionId: string): string | undefined {
    const roomId = this.byConnection.get(connectionId);
    if (roomId === undefined) return undefined;
    this.byConnection.delete(connectionId);
    const room = this.rooms.get(roomId);
    if (room) {
      room.members.delete(connectionId);
      if (room.members.size === 0) this.rooms.delete(roomId);
    }
    return roomId;
  }

  /** Route `message` to the slot it names; returns the target and sender slots. */
  signal(
    connectionId: string,
    message: RtcSignal,
  ): { target: string; from: number } {
    const room = this.roomOf(connectionId, "signal");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can signal");
    }
    const target = [...room.members.values()].find(
      (m) => m.slot !== null && m.slot === message.to,
    );
    if (!target) {
      throw new RelayError("unknown_peer", `no player in slot ${message.to}`);
    }
    return { target: target.connectionId, from: sender.slot };
  }

  /**
   * Record the host's `game.set` (T30): the game + DIPs identity that fills
   * `room.state` and seeds the input log. Only the host (lowest occupied player
   * slot) may set it, and only while the room is still `waiting`.
   */
  setGame(connectionId: string, message: GameSet): { roomId: string; from: number } {
    const room = this.roomOf(connectionId, "game.set");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can set a game");
    }
    const hostSlot = lowestSlot(room);
    if (sender.slot !== hostSlot) {
      throw new RelayError(
        "not_host",
        `slot ${sender.slot} cannot set the game; host is slot ${hostSlot}`,
      );
    }
    if (room.status !== "waiting") {
      throw new RelayError("already_started", `room ${room.id} has already started`);
    }
    room.game = {
      driver: message.driver,
      coreHash: message.coreHash,
      mameCommit: message.mameCommit,
      romHash: message.romHash,
      dips: { ...message.dips },
    };
    return { roomId: room.id, from: sender.slot };
  }

  /**
   * Record the host's `game.start` on the room and flip it to `playing`.
   * The host is the lowest occupied player slot. Returns the room id and the
   * authoritative sender slot.
   */
  begin(connectionId: string, message: GameStart): { roomId: string; from: number } {
    const room = this.roomOf(connectionId, "game.start");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can start a game");
    }
    const hostSlot = lowestSlot(room);
    if (sender.slot !== hostSlot) {
      throw new RelayError(
        "not_host",
        `slot ${sender.slot} cannot start; host is slot ${hostSlot}`,
      );
    }
    if (room.status === "playing") {
      throw new RelayError("already_started", `room ${room.id} has already started`);
    }
    room.status = "playing";
    room.start = { startFrame: message.startFrame, inputDelay: message.inputDelay };
    // A new match invalidates any live-join snapshot from a previous one (T31).
    room.snapshot = null;
    room.hashFrame = -1;
    room.hashes.clear();
    // Open the input log when the host has set the game (T30); without a
    // `game.set` there is no match identity to log, so no log is recorded.
    room.log = room.game
      ? new InputLogRecorder(room.id, room.game, {
          frame: message.startFrame,
          inputDelay: message.inputDelay,
          players: seatedPlayers(room),
        })
      : null;
    return { roomId: room.id, from: sender.slot };
  }

  /**
   * Append a seated player's binary input packet to the open log (T30) and
   * report where a valid packet should be fanned out (T31). A non-seated
   * sender, a room that is not `playing`, a malformed packet or a packet
   * claiming another slot is rejected with an empty fan-out. `fanout` lists
   * every other member (the packet is authenticated, so it is safe to relay).
   */
  recordInput(
    connectionId: string,
    bytes: Uint8Array,
  ): { recorded: boolean; fanout: string[] } {
    const deny = { recorded: false, fanout: [] };
    // Binary input is best-effort: a frame from a connection that is not a
    // seated player in a playing room is silently ignored rather than answered
    // with a JSON error (there is no useful reply to a stray binary frame).
    const roomId = this.byConnection.get(connectionId);
    const room = roomId === undefined ? undefined : this.rooms.get(roomId);
    if (!room) return deny;
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) return deny;
    if (room.status !== "playing" || !room.log) return deny;
    let packet: InputPacket;
    try {
      packet = decodeInput(bytes);
    } catch {
      return deny;
    }
    // The packet's `player` is untrusted (client-supplied). The authenticated
    // connection owns exactly one slot, so a frame claiming another slot is
    // dropped and **never fanned out**: without this a seated player could
    // pre-seed a victim's slot for peers/viewers (first-write-wins) and forge
    // their inputs. Mirrors `hash`, which stamps sender.slot rather than
    // trusting the wire.
    if (packet.player !== sender.slot) return deny;
    const recorded = room.log.append(packet);
    const fanout = [...room.members.keys()].filter((id) => id !== connectionId);
    return { recorded, fanout };
  }

  /**
   * Close the match on the host's `game.end` (T30). Only the host (lowest
   * occupied player slot) in a `playing` room may end; the room becomes
   * `ended` and the input log (if any) is returned for storage.
   */
  end(
    connectionId: string,
    message: GameEnd,
  ): { roomId: string; from: number; log: InputLog | null } {
    const room = this.roomOf(connectionId, "game.end");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can end a game");
    }
    if (room.status !== "playing") {
      throw new RelayError("not_playing", `room ${room.id} is not playing`);
    }
    const hostSlot = lowestSlot(room);
    if (sender.slot !== hostSlot) {
      throw new RelayError(
        "not_host",
        `slot ${sender.slot} cannot end; host is slot ${hostSlot}`,
      );
    }
    room.status = "ended";
    room.snapshot = null;
    const recorder = room.log;
    room.log = null;
    return {
      roomId: room.id,
      from: sender.slot,
      log: recorder ? recorder.close(message.frame, []) : null,
    };
  }

  /**
   * Record a seated player's ready flag. Only seated players may toggle; a
   * viewer or unjoined connection is rejected with `not_joined`. Returns the
   * room id and the authoritative sender slot (client-supplied `player` is
   * ignored). (docs/contracts/ws-messages.md, T27.)
   */
  setReady(
    connectionId: string,
    message: PlayerReady,
  ): { roomId: string; from: number } {
    const room = this.roomOf(connectionId, "player.ready");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can set ready");
    }
    sender.ready = message.ready;
    return { roomId: room.id, from: sender.slot };
  }

  /**
   * Record a seated player's frame hash for desync detection (T25, docs/03).
   * Hashes are compared per frame across players; a genuine same-frame
   * disagreement is reported so the caller can broadcast `desync`. Only seated
   * players in a `playing` room may report; a repeated hash from the same slot
   * for the same frame is ignored (first write wins) and a stale frame is
   * dropped, so a driven peer cannot flap the comparison.
   */
  recordHash(connectionId: string, message: HashMessage): HashResult {
    const room = this.roomOf(connectionId, "hash");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can report a hash");
    }
    if (room.status !== "playing") {
      throw new RelayError("not_playing", `room ${room.id} has not started`);
    }
    if (message.frame < room.hashFrame) {
      return { roomId: room.id, slot: sender.slot, frame: message.frame, mismatch: false };
    }
    // A single peer must not be able to suppress detection by announcing an
    // absurd frame (which would strand `hashFrame` past every real one). Ignore
    // any frame further than a generous window from the room's start, and any
    // jump larger than that window; legitimate hashes advance ~60 per report.
    const origin = room.start?.startFrame ?? 0;
    if (
      message.frame > origin + MAX_HASH_FRAME_JUMP ||
      (room.hashFrame >= 0 && message.frame - room.hashFrame > MAX_HASH_FRAME_JUMP)
    ) {
      return { roomId: room.id, slot: sender.slot, frame: message.frame, mismatch: false };
    }
    if (message.frame > room.hashFrame) {
      room.hashFrame = message.frame;
      room.hashes.clear();
    }
    if (room.hashes.has(sender.slot)) {
      return { roomId: room.id, slot: sender.slot, frame: message.frame, mismatch: false };
    }
    let mismatch = false;
    for (const value of room.hashes.values()) {
      if (value !== message.crc32) mismatch = true;
    }
    room.hashes.set(sender.slot, message.crc32);
    return { roomId: room.id, slot: sender.slot, frame: message.frame, mismatch };
  }

  /**
   * Validate a host's `state.snapshot` for desync recovery (T25, docs/03). Only
   * the host (lowest occupied player slot) in a `playing` room may send one; the
   * relay then fans it out to the other members.
   */
  snapshotForResync(
    connectionId: string,
  ): { roomId: string; from: number } {
    const room = this.roomOf(connectionId, "state.snapshot");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can send a snapshot");
    }
    if (room.status !== "playing") {
      throw new RelayError("not_playing", `room ${room.id} has not started`);
    }
    const hostSlot = lowestSlot(room);
    if (sender.slot !== hostSlot) {
      throw new RelayError(
        "not_host",
        `slot ${sender.slot} cannot send a snapshot; host is slot ${hostSlot}`,
      );
    }
    return { roomId: room.id, from: sender.slot };
  }

  /** A `room.state` snapshot for the connection's room. */
  snapshot(connectionId: string): RoomState {
    const room = this.roomOf(connectionId, "snapshot");
    const players = [...room.members.values()]
      .filter((m): m is RoomMember & { slot: number } => m.slot !== null)
      .sort((a, b) => a.slot - b.slot)
      .map((m) => ({ slot: m.slot, name: m.name, ready: m.ready }));
    return {
      t: "room.state",
      room: room.id,
      self: room.members.get(connectionId)?.slot ?? null,
      players,
      game: room.game?.driver ?? null,
      coreHash: room.game?.coreHash ?? null,
      romHash: room.game?.romHash ?? null,
      dips: room.game ? { ...room.game.dips } : {},
      status: room.status,
    };
  }

  /**
   * Record the host's live-join snapshot (T31). Only the host (lowest occupied
   * player slot) in a `playing` room may publish one; the relay stores it as the
   * point a later viewer resumes from and forwards it to viewers only.
   */
  recordViewerSnapshot(
    connectionId: string,
    message: ViewerSnapshot,
  ): { roomId: string; from: number } {
    const room = this.roomOf(connectionId, "viewer.snapshot");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can publish a snapshot");
    }
    if (room.status !== "playing") {
      throw new RelayError("not_playing", `room ${room.id} has not started`);
    }
    const hostSlot = lowestSlot(room);
    if (sender.slot !== hostSlot) {
      throw new RelayError(
        "not_host",
        `slot ${sender.slot} cannot publish a snapshot; host is slot ${hostSlot}`,
      );
    }
    room.snapshot = { frame: message.frame, blobUrl: message.blobUrl };
    return { roomId: room.id, from: sender.slot };
  }

  /** Viewer connections in a room, optionally excluding one (T31). */
  viewerTargets(roomId: string, exceptConnectionId?: string): string[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return [...room.members.values()]
      .filter((m) => m.role === "viewer" && m.connectionId !== exceptConnectionId)
      .map((m) => m.connectionId);
  }

  /** The live-join handshake for a viewer, or null (not a viewer / not playing). */
  viewerState(connectionId: string): ViewerState | null {
    const roomId = this.byConnection.get(connectionId);
    const room = roomId === undefined ? undefined : this.rooms.get(roomId);
    if (!room || !room.game || !room.start || room.status !== "playing") return null;
    const member = room.members.get(connectionId);
    if (!member || member.role !== "viewer") return null;
    return {
      t: "viewer.state",
      room: room.id,
      driver: room.game.driver,
      coreHash: room.game.coreHash,
      mameCommit: room.game.mameCommit,
      romHash: room.game.romHash,
      dips: { ...room.game.dips },
      startFrame: room.start.startFrame,
      inputDelay: room.start.inputDelay,
      players: seatedPlayers(room),
      snapshot: room.snapshot ? { ...room.snapshot } : null,
    };
  }

  /** Every viewer's live-join handshake in a room (T31). */
  viewerStates(roomId: string): { connectionId: string; message: ViewerState }[] {
    const out: { connectionId: string; message: ViewerState }[] = [];
    for (const connectionId of this.viewerTargets(roomId)) {
      const message = this.viewerState(connectionId);
      if (message) out.push({ connectionId, message });
    }
    return out;
  }

  /**
   * Recorded inputs to resend to a stalled seated player (T31 stall recovery):
   * frames from `fromFrame` to the highest recorded frame. A non-seated sender
   * or a non-playing room is rejected, mirroring `hash`/`input`.
   */
  resyncFrom(
    connectionId: string,
    fromFrame: number,
  ): { roomId: string; frames: Uint8Array[] } {
    const room = this.roomOf(connectionId, "input.request");
    const sender = room.members.get(connectionId);
    if (!sender || sender.slot === null) {
      throw new RelayError("not_joined", "only seated players can request a resync");
    }
    if (room.status !== "playing") {
      throw new RelayError("not_playing", `room ${room.id} has not started`);
    }
    return { roomId: room.id, frames: this.catchUpPackets(room.id, fromFrame) };
  }

  /**
   * Encoded catch-up packets for a joining viewer: the recorded inputs from
   * `fromFrame` to the highest recorded frame (T31). Empty without an open log.
   */
  catchUpPackets(roomId: string, fromFrame: number): Uint8Array[] {
    const room = this.rooms.get(roomId);
    if (!room?.log) return [];
    return room.log.since(fromFrame).map((packet) => encodeInput(packet));
  }

  /** The room a connection is in, or undefined. */
  roomIdOf(connectionId: string): string | undefined {
    return this.byConnection.get(connectionId);
  }

  /** Connections to notify about a room change (empty if the room is gone). */
  broadcastTargets(roomId: string): string[] {
    const room = this.rooms.get(roomId);
    return room ? [...room.members.keys()] : [];
  }

  private ensureRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        members: new Map(),
        status: "waiting",
        start: null,
        game: null,
        log: null,
        snapshot: null,
        hashFrame: -1,
        hashes: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private roomOf(connectionId: string, action: string): Room {
    const roomId = this.byConnection.get(connectionId);
    const room = roomId === undefined ? undefined : this.rooms.get(roomId);
    if (!room) {
      throw new RelayError("not_joined", `connection is not in a room (${action})`);
    }
    return room;
  }

  private freeSlot(room: Room): number {
    const used = new Set(
      [...room.members.values()]
        .map((m) => m.slot)
        .filter((slot): slot is number => slot !== null),
    );
    for (let slot = 0; slot < PLAYER_SLOTS; slot++) {
      if (!used.has(slot)) return slot;
    }
    throw new RelayError("room_full", `room ${room.id} has no free player slot`);
  }
}
