import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { createRelayServer, type RelayServer } from "./server";
import { TokenError, type TokenClaims, type TokenVerifier } from "./token";

const fakeVerifier: TokenVerifier = {
  verify(token: string): TokenClaims {
    if (token === "bad") throw new TokenError("nope");
    return { sub: token, exp: 9_999_999_999 };
  },
};

const TIMEOUT_MS = 3000;

class TestClient {
  readonly socket: WebSocket;
  private queue: unknown[] = [];
  private waiters: ((message: unknown) => void)[] = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.socket.on("message", (data: RawData) => {
      const message = JSON.parse(data.toString());
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  async open(): Promise<void> {
    await once(this.socket, "open");
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued as Record<string, unknown>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), TIMEOUT_MS);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message as Record<string, unknown>);
      });
    });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(data: string | Uint8Array): void {
    this.socket.send(data);
  }
}

const join = (token: string) => ({
  t: "room.join",
  room: "r",
  role: "player",
  token,
});

describe("createRelayServer", () => {
  let server: RelayServer;
  let clients: TestClient[];

  beforeEach(async () => {
    server = await createRelayServer({ port: 0, verifier: fakeVerifier });
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.socket.close();
    await server.close();
  });

  async function client(): Promise<TestClient> {
    const c = new TestClient(server.port);
    clients.push(c);
    await c.open();
    return c;
  }

  it("answers room.join with a room.state", async () => {
    const c = await client();
    c.send(join("alice"));
    expect(await c.next()).toMatchObject({
      t: "room.state",
      players: [{ slot: 0, name: "player" }],
    });
  });

  it("broadcasts the updated room.state to both players", async () => {
    const a = await client();
    a.send(join("alice"));
    await a.next();

    const b = await client();
    b.send(join("bob"));

    expect(await a.next()).toMatchObject({
      t: "room.state",
      players: [
        { slot: 0, name: "player" },
        { slot: 1, name: "player" },
      ],
    });
    expect(await b.next()).toMatchObject({ t: "room.state" });
  });

  it("routes rtc.signal only to the target", async () => {
    const a = await client();
    a.send(join("alice"));
    await a.next();
    const b = await client();
    b.send(join("bob"));
    await a.next();
    await b.next();

    a.send({ t: "rtc.signal", to: 1, sdp: { type: "offer" } });
    expect(await b.next()).toEqual({
      t: "rtc.signal",
      from: 0,
      to: 1,
      sdp: { type: "offer" },
    });
  });

  it("rejects an invalid token", async () => {
    const c = await client();
    c.send(join("bad"));
    expect(await c.next()).toMatchObject({ t: "error", code: "invalid_token" });
  });

  it("reports malformed JSON", async () => {
    const c = await client();
    c.sendRaw("{ not json");
    expect(await c.next()).toMatchObject({ t: "error", code: "bad_message" });
  });

  it("accepts a binary input frame without an error reply", async () => {
    const c = await client();
    c.sendRaw(new Uint8Array([1, 2, 3]));
    // The input log/fan-out land with T30; until then the frame is accepted
    // silently, so the next reply to the client is its room.state.
    c.send(join("alice"));
    expect(await c.next()).toMatchObject({ t: "room.state" });
  });

  it("broadcasts the room without a disconnecter", async () => {
    const a = await client();
    a.send(join("alice"));
    await a.next();
    const b = await client();
    b.send(join("bob"));
    await a.next();
    await b.next();

    b.socket.close();
    expect(await a.next()).toMatchObject({
      t: "room.state",
      players: [{ slot: 0, name: "player" }],
    });
  });

  it("rejects an upgrade on a path other than /ws", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/nope`);
    await new Promise<void>((resolve) => {
      socket.on("error", () => resolve());
      socket.on("close", () => resolve());
    });
    expect(socket.readyState).not.toBe(WebSocket.OPEN);
  });

  it("terminates a peer that stops answering pings", async () => {
    const hb = await createRelayServer({
      port: 0,
      verifier: fakeVerifier,
      heartbeatMs: 20,
    });
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${hb.port}/ws`, { autoPong: false });
      await once(socket, "open");
      const [code] = await once(socket, "close");
      expect(code).toBe(1006);
    } finally {
      await hb.close();
    }
  });

  it("closes connected clients with a going-away frame", async () => {
    const c = await client();
    const closed = once(c.socket, "close");
    await server.close();
    const [code] = await closed;
    expect(code).toBe(1001);
  });

  describe("snapshot blobs (T25)", () => {
    const base = () => `http://127.0.0.1:${server.port}`;

    it("stores a snapshot and serves it back at the returned url", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const post = await fetch(`${base()}/rooms/r/snapshot`, {
        method: "POST",
        body: bytes,
      });
      expect(post.status).toBe(200);
      const { url } = (await post.json()) as { url: string };
      expect(url).toContain("/rooms/r/snapshot/");

      const get = await fetch(url);
      expect(get.status).toBe(200);
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
    });

    it("keeps a short history of snapshots so recent urls keep resolving", async () => {
      const first = await fetch(`${base()}/rooms/r/snapshot`, {
        method: "POST",
        body: new Uint8Array([1]),
      });
      const { url: firstUrl } = (await first.json()) as { url: string };
      const second = await fetch(`${base()}/rooms/r/snapshot`, {
        method: "POST",
        body: new Uint8Array([2]),
      });
      const { url: secondUrl } = (await second.json()) as { url: string };

      // A url handed out just before another desync still resolves.
      expect(new Uint8Array(await (await fetch(firstUrl)).arrayBuffer())).toEqual(
        new Uint8Array([1]),
      );
      expect(new Uint8Array(await (await fetch(secondUrl)).arrayBuffer())).toEqual(
        new Uint8Array([2]),
      );

      // Only the most recent few are retained.
      for (let i = 0; i < 5; i++) {
        await fetch(`${base()}/rooms/r/snapshot`, {
          method: "POST",
          body: new Uint8Array([10 + i]),
        });
      }
      expect((await fetch(firstUrl)).status).toBe(404);
    });

    it("404s an unknown snapshot id", async () => {
      expect((await fetch(`${base()}/rooms/r/snapshot/nope`)).status).toBe(404);
    });

    it("400s an empty body", async () => {
      const response = await fetch(`${base()}/rooms/r/snapshot`, { method: "POST" });
      expect(response.status).toBe(400);
    });
  });
});
