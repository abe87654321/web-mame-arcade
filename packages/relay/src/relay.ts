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
}

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
  /** Handle one binary input frame; returns messages to send (usually none). */
  input(connectionId: string, bytes: Uint8Array): Outbound[];
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
            return roomId ? snapshotOut(roomId) : [];
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
            return [...starts, ...snapshotOut(roomId)];
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

    input(connectionId: string, bytes: Uint8Array): Outbound[] {
      // Best-effort recording; binary frames never elicit a JSON reply.
      rooms.recordInput(connectionId, bytes);
      return [];
    },

    leave(connectionId: string): Outbound[] {
      const roomId = rooms.leave(connectionId);
      return roomId ? snapshotOut(roomId) : [];
    },
  };
}
