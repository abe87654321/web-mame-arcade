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
  /** Inbound binary `input` frame (docs/contracts/input-packet.md). */
  onBinary?: (data: ArrayBuffer) => void;
  /** The relay socket closed (self-disconnect); drives the lobby status (T27). */
  onClose?: () => void;
}

export interface RelayClient {
  /** Send a client JSON message; false when the socket is not open. */
  send(message: ClientMessage): boolean;
  /** Send a binary input packet; false when the socket is not open. */
  sendBinary(data: ArrayBuffer): boolean;
  close(): void;
}

/** Normalise an inbound WebSocket frame to an ArrayBuffer, or null. */
function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const copy = new Uint8Array(view.length);
    copy.set(view);
    return copy.buffer as ArrayBuffer;
  }
  return null;
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const socket: WebSocketLike = options.socketFactory.create(options.url);
  socket.binaryType = "arraybuffer";

  socket.onopen = () => {
    socket.send(JSON.stringify({ t: "room.join", ...options.join }));
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      const bytes = toArrayBuffer(event.data);
      if (bytes) options.onBinary?.(bytes);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = serverMessage.safeParse(value);
    if (parsed.success) options.onMessage(parsed.data);
  };

  socket.onclose = () => {
    options.onClose?.();
  };

  return {
    send(message: ClientMessage): boolean {
      if (socket.readyState !== OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    sendBinary(data: ArrayBuffer): boolean {
      if (socket.readyState !== OPEN) return false;
      socket.send(data);
      return true;
    },
    close(): void {
      socket.close();
    },
  };
}
