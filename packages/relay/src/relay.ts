/**
 * Transport-agnostic relay dispatcher: validates client messages against the
 * protocol union and routes them to {@link RoomManager}. The socket binding
 * (server.ts) only parses frames and serialises the returned messages.
 */
import { randomUUID } from "node:crypto";
import {
  clientMessage,
  type ServerMessage,
} from "@wma/protocol";
import { gzipInputLog, inputLogKey } from "./input-log.ts";
import { RelayError, RoomManager } from "./room.ts";
import { TokenError, type TokenVerifier } from "./token.ts";

export interface Outbound {
  connectionId: string;
  message: ServerMessage;
  /**
   * Binary frames to send after the JSON message (T31): a joining viewer's
   * catch-up inputs, delivered right after its `viewer.state`.
   */
  frames?: Uint8Array[];
}

/** A standalone binary frame fanned out to a member (T31 input fan-out). */
export interface BinaryOutbound {
  connectionId: string;
  binary: Uint8Array;
}

/** Any outbound entry the socket binding must serialise. */
export type RelayOut = Outbound | BinaryOutbound;

/** A closed match log handed to the caller for storage (T30). */
export interface ClosedLog {
  room: string;
  /** Object-storage key of the gzip(JSON) artifact (docs/contracts/input-log.md). */
  replayKey: string;
  driver: string;
  coreHash: string;
  mameCommit: string;
  bytes: Uint8Array;
}

export interface Relay {
  /** Handle one decoded JSON message; returns messages to send. */
  handle(connectionId: string, value: unknown): Outbound[];
  /** Handle one binary input frame; returns binary fan-out frames (T31). */
  input(connectionId: string, bytes: Uint8Array): BinaryOutbound[];
  /** Handle a disconnect; returns the resulting room.state broadcasts. */
  leave(connectionId: string): Outbound[];
}

function errorOut(connectionId: string, code: string, message: string): Outbound[] {
  return [{ connectionId, message: { t: "error", code, message } }];
}

export function createRelay({
  verifier,
  log,
  onLogClosed,
}: {
  verifier: TokenVerifier;
  /** Optional structured logger for desync/resync events (T25). */
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Called with a closed match log to persist (T30). */
  onLogClosed?: (closed: ClosedLog) => void;
}): Relay {
  const rooms = new RoomManager(verifier);

  function snapshotOut(roomId: string): Outbound[] {
    return rooms
      .broadcastTargets(roomId)
      .map((connectionId) => ({ connectionId, message: rooms.snapshot(connectionId) }));
  }

  /** Every viewer's live-join handshake in a room (T31). */
  function viewerStateOut(roomId: string): Outbound[] {
    return rooms.viewerStates(roomId);
  }

  return {
    handle(connectionId: string, value: unknown): Outbound[] {
      const parsed = clientMessage.safeParse(value);
      if (!parsed.success) {
        return errorOut(connectionId, "bad_message", "malformed relay message");
      }
      const message = parsed.data;

      try {
        switch (message.t) {
          case "room.join": {
            const member = rooms.join(connectionId, {
              room: message.room,
              role: message.role,
              token: message.token,
            });
            const roomId = rooms.roomIdOf(member.connectionId);
            if (!roomId) return [];
            const out: Outbound[] = snapshotOut(roomId);
            // A viewer joining a playing match gets the match identity and the
            // host's latest snapshot, then the inputs to fast-forward to live
            // (T31): the catch-up is attached to the viewer.state reply.
            if (member.role === "viewer") {
              const state = rooms.viewerState(member.connectionId);
              if (state) {
                const fromFrame = state.snapshot
                  ? state.snapshot.frame + 1
                  : state.startFrame;
                out.push({
                  connectionId: member.connectionId,
                  message: state,
                  frames: rooms.catchUpPackets(roomId, fromFrame),
                });
              }
            }
            return out;
          }
          case "player.ready": {
            // Stamp the sender's own slot and fan the toggle out, then reflect
            // the new flags in everyone's room.state (T27, docs/contracts).
            const { roomId, from } = rooms.setReady(connectionId, message);
            const toggles: Outbound[] = rooms
              .broadcastTargets(roomId)
              .map((target) => ({
                connectionId: target,
                message: { ...message, player: from },
              }));
            return [...toggles, ...snapshotOut(roomId)];
          }
          case "rtc.signal": {
            const { target, from } = rooms.signal(connectionId, message);
            return [{ connectionId: target, message: { ...message, from } }];
          }
          case "game.set": {
            // The host's game + DIPs is stored on the room and fanned out so
            // every member sees the match identity; room.state now carries the
            // driver/core/rom hashes (T30, docs/contracts/ws-messages.md).
            const { roomId } = rooms.setGame(connectionId, message);
            const sets: Outbound[] = rooms
              .broadcastTargets(roomId)
              .map((target) => ({ connectionId: target, message }));
            return [...sets, ...snapshotOut(roomId)];
          }
          case "game.start": {
            // The host's start is fanned out to the whole room so every peer
            // agrees on startFrame/inputDelay, and the updated room.state flips
            // status to "playing" for the lobby UI (T24, docs/03).
            const { roomId } = rooms.begin(connectionId, message);
            const starts: Outbound[] = rooms
              .broadcastTargets(roomId)
              .map((target) => ({ connectionId: target, message }));
            // Viewers that joined before the start learn the roster/delay too (T31).
            return [...starts, ...snapshotOut(roomId), ...viewerStateOut(roomId)];
          }
          case "game.end": {
            // The host closes the match: store the input log and queue
            // verification, then fan the end out and flip room.state to
            // "ended" (T30, docs/contracts/input-log.md).
            const { roomId, log: closedLog } = rooms.end(connectionId, message);
            if (closedLog) {
              const replayKey = inputLogKey(roomId, randomUUID());
              log?.("input-log", {
                room: roomId,
                replayKey,
                frames: closedLog.frames.length,
              });
              onLogClosed?.({
                room: roomId,
                replayKey,
                driver: closedLog.meta.driver,
                coreHash: closedLog.meta.core_hash,
                mameCommit: closedLog.meta.mame_commit,
                bytes: gzipInputLog(closedLog),
              });
            }
            // `game.end` is client→relay only (docs/contracts/ws-messages.md);
            // the room learns it ended from the refreshed room.state.
            return snapshotOut(roomId);
          }
          case "hash": {
            // Compare this player's frame hash against the others'; a genuine
            // same-frame mismatch is broadcast as `desync` (T25, docs/03).
            const result = rooms.recordHash(connectionId, message);
            if (!result.mismatch) return [];
            log?.("desync", { room: result.roomId, frame: result.frame });
            return rooms.broadcastTargets(result.roomId).map((target) => ({
              connectionId: target,
              message: { t: "desync" as const, frame: result.frame },
            }));
          }
          case "input.request": {
            // A stalled player asks for the recorded inputs from `fromFrame`;
            // the relay resends them from the log so it can catch up (T31).
            const { frames } = rooms.resyncFrom(connectionId, message.fromFrame);
            return [
              {
                connectionId,
                message: { t: "input.resync", fromFrame: message.fromFrame },
                frames,
              },
            ];
          }
          case "viewer.snapshot": {
            // The host's live-join snapshot (T31): stored on the room and
            // forwarded to viewers only (never a resync for players).
            const { roomId } = rooms.recordViewerSnapshot(connectionId, message);
            return rooms
              .viewerTargets(roomId)
              .map((target) => ({ connectionId: target, message }));
          }
          case "state.snapshot": {
            // The host's recovery snapshot is fanned out to everyone else so
            // each desynced peer can fetch and load it (T25, docs/03).
            const { roomId, from } = rooms.snapshotForResync(connectionId);
            log?.("resync", { room: roomId, frame: message.frame, from });
            return rooms
              .broadcastTargets(roomId)
              .filter((target) => target !== connectionId)
              .map((target) => ({ connectionId: target, message }));
          }
          default:
            // score.live/chat are owned by later tasks (T32/T36).
            return errorOut(
              connectionId,
              "unsupported",
              `${message.t} is not handled yet`,
            );
        }
      } catch (error) {
        if (error instanceof RelayError) {
          return errorOut(connectionId, error.code, error.message);
        }
        if (error instanceof TokenError) {
          return errorOut(connectionId, error.code, error.message);
        }
        throw error;
      }
    },

    input(connectionId: string, bytes: Uint8Array): BinaryOutbound[] {
      // Best-effort recording; binary frames never elicit a JSON reply. Only an
      // authenticated packet (seated sender, playing room, `player` == its
      // slot) is fanned out, so a forged slot cannot reach peers or viewers.
      const { fanout } = rooms.recordInput(connectionId, bytes);
      return fanout.map((target) => ({ connectionId: target, binary: bytes }));
    },

    leave(connectionId: string): Outbound[] {
      const roomId = rooms.leave(connectionId);
      return roomId ? snapshotOut(roomId) : [];
    },
  };
}
