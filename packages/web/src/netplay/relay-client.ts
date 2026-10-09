/**
 * Relay WebSocket client for netplay (T23). Owns only the socket: it joins the
 * room on open, validates inbound frames against the server union and hands
 * well-formed messages to the caller. The WebSocket is injected so tests need
 * no network. Binary `input` frames are ignored here (T30).
 */
import {
  serverMessage,
  type ClientMessage,
  type ServerMessage,
} from "@wma/protocol";
import type { WebSocketFactory, WebSocketLike } from "./types";

const OPEN = 1;

export interface RelayJoin {
  room: string;
  role: "player" | "viewer";
  token: string;
}

export interface RelayClientOptions {
  url: string;
  join: RelayJoin;
  socketFactory: WebSocketFactory;
  onMessage: (message: ServerMessage) => void;
}

export interface RelayClient {
  /** Send a client message; false when the socket is not open. */
  send(message: ClientMessage): boolean;
  close(): void;
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const socket: WebSocketLike = options.socketFactory.create(options.url);

  socket.onopen = () => {
    socket.send(JSON.stringify({ t: "room.join", ...options.join }));
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = serverMessage.safeParse(value);
    if (parsed.success) options.onMessage(parsed.data);
  };

  return {
    send(message: ClientMessage): boolean {
      if (socket.readyState !== OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    close(): void {
      socket.close();
    },
  };
}
