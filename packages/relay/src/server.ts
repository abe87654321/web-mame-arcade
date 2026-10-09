/**
 * WebSocket socket binding for the relay. Keeps all room logic in
 * {@link createRelay}; this file only moves frames and owns liveness.
 *
 * Transport note: docs/06 pins uWebSockets.js for scale-out. T22 uses `ws`
 * (pure JS, testable in CI); the swap lands with the T44 scale-out work.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { ServerMessage } from "@wma/protocol";
import { createRelay, type Outbound } from "./relay.ts";
import type { TokenVerifier } from "./token.ts";

export interface RelayServerOptions {
  verifier: TokenVerifier;
  /** Default 8787; 0 asks the OS for a free port. */
  port?: number;
  /** Default 127.0.0.1; deployments pass 0.0.0.0. */
  host?: string;
  /** WebSocket path; default `/ws`. */
  path?: string;
  /** Ping interval in ms; default 30s. */
  heartbeatMs?: number;
}

export interface RelayServer {
  /** The bound port (useful when `port: 0`). */
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PATH = "/ws";
const DEFAULT_HEARTBEAT_MS = 30_000;

export function createRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const path = options.path ?? DEFAULT_PATH;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const relay = createRelay({ verifier: options.verifier });

  const httpServer = createServer((_request, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("upgrade required");
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<string, WebSocket>();
  const alive = new WeakMap<WebSocket, boolean>();

  function send(connectionId: string, message: ServerMessage): void {
    const socket = sockets.get(connectionId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function dispatch(out: Outbound[]): void {
    for (const { connectionId, message } of out) send(connectionId, message);
  }

  wss.on("connection", (socket: WebSocket) => {
    const connectionId = randomUUID();
    sockets.set(connectionId, socket);
    alive.set(socket, true);

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        // Binary frames are `input` packets (docs/contracts/input-packet.md).
        // T24 transports them to the relay; the append-only log and spectator
        // fan-out are T30/T31, so accept and drop for now.
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        send(connectionId, { t: "error", code: "bad_message", message: "malformed JSON" });
        return;
      }
      dispatch(relay.handle(connectionId, value));
    });

    socket.on("close", () => {
      sockets.delete(connectionId);
      dispatch(relay.leave(connectionId));
    });

    socket.on("pong", () => alive.set(socket, true));
  });

  httpServer.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.values()) {
      if (alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      alive.set(socket, false);
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  const port = options.port ?? 8787;
  return new Promise<RelayServer>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, options.host ?? "127.0.0.1", () => {
      const address = httpServer.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const socket of sockets.values()) {
              if (socket.readyState === WebSocket.OPEN) {
                socket.close(1001, "relay shutting down");
              } else {
                socket.terminate();
              }
            }
            const force = setTimeout(() => {
              for (const socket of sockets.values()) socket.terminate();
            }, 250);
            force.unref();
            wss.close(() =>
              httpServer.close(() => {
                clearTimeout(force);
                done();
              }),
            );
          }),
      });
    });
  });
}
