/**
 * In-memory rooms and WebRTC signalling routing, transport-agnostic so the
 * socket binding (server.ts) and the relay dispatcher (relay.ts) can stay
 * thin. Semantics: docs/03-netplay-protocol.md, docs/contracts/ws-messages.md.
 */
import { PLAYER_SLOTS, type RoomState, type RtcSignal } from "@wma/protocol";
import type { TokenVerifier } from "./token.ts";

export type Role = "player" | "viewer";

export interface RoomMember {
  connectionId: string;
  sub: string;
  name: string;
  role: Role;
  /** Player slot 0-3, or null for viewers. */
  slot: number | null;
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

interface Room {
  id: string;
  members: Map<string, RoomMember>;
}

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

  /** Return the connection seated in `message.to`'s slot, in the sender's room. */
  signal(connectionId: string, message: RtcSignal): string {
    const room = this.roomOf(connectionId, "signal");
    const target = [...room.members.values()].find(
      (m) => m.slot !== null && m.slot === message.to,
    );
    if (!target) {
      throw new RelayError("unknown_peer", `no player in slot ${message.to}`);
    }
    return target.connectionId;
  }

  /** A `room.state` snapshot for the connection's room. */
  snapshot(connectionId: string): RoomState {
    const room = this.roomOf(connectionId, "snapshot");
    const players = [...room.members.values()]
      .filter((m): m is RoomMember & { slot: number } => m.slot !== null)
      .sort((a, b) => a.slot - b.slot)
      .map((m) => ({ slot: m.slot, name: m.name }));
    return {
      t: "room.state",
      room: room.id,
      players,
      game: null,
      coreHash: null,
      romHash: null,
      dips: {},
      status: "waiting",
    };
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
      room = { id: roomId, members: new Map() };
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
