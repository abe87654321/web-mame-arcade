/**
 * Transport-agnostic relay dispatcher: validates client messages against the
 * protocol union and routes them to {@link RoomManager}. The socket binding
 * (server.ts) only parses frames and serialises the returned messages.
 */
import {
  clientMessage,
  type ServerMessage,
} from "@wma/protocol";
import { RelayError, RoomManager } from "./room.ts";
import { TokenError, type TokenVerifier } from "./token.ts";

export interface Outbound {
  connectionId: string;
  message: ServerMessage;
}

export interface Relay {
  /** Handle one decoded JSON message; returns messages to send. */
  handle(connectionId: string, value: unknown): Outbound[];
  /** Handle a disconnect; returns the resulting room.state broadcasts. */
  leave(connectionId: string): Outbound[];
}

function errorOut(connectionId: string, code: string, message: string): Outbound[] {
  return [{ connectionId, message: { t: "error", code, message } }];
}

export function createRelay({ verifier }: { verifier: TokenVerifier }): Relay {
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
          default:
            // input/hash/state.snapshot/score.live/game.end/chat are owned by
            // later tasks (T30/T32/T36).
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

    leave(connectionId: string): Outbound[] {
      const roomId = rooms.leave(connectionId);
      return roomId ? snapshotOut(roomId) : [];
    },
  };
}
