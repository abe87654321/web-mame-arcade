/**
 * WebSocket socket binding for the relay. Keeps all room logic in
 * {@link createRelay}; this file only moves frames and owns liveness.
 *
 * Transport note: docs/06 pins uWebSockets.js for scale-out. T22 uses `ws`
 * (pure JS, testable in CI); the swap lands with the T44 scale-out work.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  /** Structured desync/resync log; defaults to JSON lines on stdout. */
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface RelayServer {
  /** The bound port (useful when `port: 0`). */
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PATH = "/ws";
const DEFAULT_HEARTBEAT_MS = 30_000;
/** Hard cap on a single snapshot blob (T25); object storage is T30. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** Recent snapshots kept per room so a superseded blob URL still resolves (T25). */
const MAX_SNAPSHOTS_PER_ROOM = 4;

export function createRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const path = options.path ?? DEFAULT_PATH;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const relay = createRelay({
    verifier: options.verifier,
    log:
      options.log ??
      ((event, fields) => console.log(JSON.stringify({ event, ...fields }))),
  });
  // Recent desync-recovery snapshots per room (T25), newest first. Keeping a
  // short history means a url handed out just before another desync still
  // resolves instead of 404ing mid-fetch. Unguessable id: only a peer that
  // received the blob URL via `state.snapshot` can fetch it; the host gate lives
  // on the WS message (RoomManager.snapshotForResync).
  const snapshots = new Map<string, { id: string; bytes: Buffer }[]>();

  function readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      request.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_SNAPSHOT_BYTES) {
          reject(new Error("too_large"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });
  }

  async function handleSnapshotRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const post = /^\/rooms\/([^/]+)\/snapshot$/.exec(pathname);
    const get = /^\/rooms\/([^/]+)\/snapshot\/([^/]+)$/.exec(pathname);
    // The relay is a different origin than the web app (and the app is served
    // COEP: require-corp), so the snapshot fetch is cross-origin: it needs CORS
    // and a cross-origin resource policy or the browser blocks it (T25).
    const cors = {
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    };

    if (request.method === "OPTIONS" && (post || get)) {
      response.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      response.end();
      return;
    }

    if (request.method === "POST" && post) {
      const room = decodeURIComponent(post[1]!);
      let body: Buffer;
      try {
        body = await readBody(request);
      } catch {
        response.writeHead(413, { ...cors, "content-type": "text/plain" });
        response.end("snapshot too large");
        return;
      }
      if (body.length === 0) {
        response.writeHead(400, { ...cors, "content-type": "text/plain" });
        response.end("empty snapshot");
        return;
      }
      const id = randomUUID();
      const history = snapshots.get(room) ?? [];
      history.unshift({ id, bytes: body });
      if (history.length > MAX_SNAPSHOTS_PER_ROOM) history.length = MAX_SNAPSHOTS_PER_ROOM;
      snapshots.set(room, history);
      // Honour a TLS-terminating proxy so the blob url is not mixed-content.
      const forwarded = request.headers["x-forwarded-proto"];
      const encrypted = (request.socket as { encrypted?: boolean }).encrypted === true;
      const scheme =
        typeof forwarded === "string" && forwarded.length > 0
          ? forwarded.split(",")[0]!.trim()
          : encrypted
            ? "https"
            : "http";
      const hostHeader = request.headers.host ?? "localhost";
      const url = `${scheme}://${hostHeader}/rooms/${encodeURIComponent(room)}/snapshot/${id}`;
      response.writeHead(200, { ...cors, "content-type": "application/json" });
      response.end(JSON.stringify({ url }));
      return;
    }

    if (request.method === "GET" && get) {
      const room = decodeURIComponent(get[1]!);
      const id = get[2]!;
      const stored = (snapshots.get(room) ?? []).find((entry) => entry.id === id);
      if (!stored) {
        response.writeHead(404, { ...cors, "content-type": "text/plain" });
        response.end("no snapshot");
        return;
      }
      response.writeHead(200, { ...cors, "content-type": "application/octet-stream" });
      response.end(stored.bytes);
      return;
    }

    response.writeHead(426, { "content-type": "text/plain" });
    response.end("upgrade required");
  }

  const httpServer = createServer((request, response) => {
    void handleSnapshotRequest(request, response);
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
