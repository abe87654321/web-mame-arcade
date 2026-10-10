import { describe, expect, it } from "vitest";
import { createRelay, type Outbound } from "./relay";
import { TokenError, type TokenClaims, type TokenVerifier } from "./token";

const fakeVerifier: TokenVerifier = {
  verify(token: string): TokenClaims {
    if (token === "bad") throw new TokenError("nope");
    return { sub: token, exp: 9_999_999_999 };
  },
};

function relay() {
  return createRelay({ verifier: fakeVerifier });
}

function join(connectionId: string, token: string) {
  return { t: "room.join", room: "r", role: "player", token };
}

function byConnection(out: Outbound[]): Record<string, Outbound> {
  return Object.fromEntries(out.map((o) => [o.connectionId, o]));
}

describe("createRelay", () => {
  it("rejects a message that is not a known client type", () => {
    const out = relay().handle("c1", { t: "nope" });
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toMatchObject({ t: "error", code: "bad_message" });
  });

  it("rejects an invalid token without seating the connection", () => {
    const r = relay();
    const out = r.handle("c1", join("c1", "bad"));
    expect(out[0]?.message).toMatchObject({ t: "error", code: "invalid_token" });
    expect(r.handle("c1", { t: "rtc.signal", to: 0 })[0]?.message).toMatchObject({
      code: "not_joined",
    });
  });

  it("answers a join with a pre-game room.state", () => {
    const out = relay().handle("c1", join("c1", "alice"));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      connectionId: "c1",
      message: {
        t: "room.state",
        room: "r",
        self: 0,
        players: [{ slot: 0, name: "player" }],
        game: null,
        coreHash: null,
        romHash: null,
        dips: {},
        status: "waiting",
      },
    });
  });

  it("broadcasts the updated room.state when a second player joins", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = byConnection(r.handle("c2", join("c2", "bob")));
    expect(Object.keys(out).sort()).toEqual(["c1", "c2"]);
    expect(out.c1?.message).toMatchObject({
      t: "room.state",
      self: 0,
      players: [
        { slot: 0, name: "player" },
        { slot: 1, name: "player" },
      ],
    });
    expect(out.c2?.message).toMatchObject({ t: "room.state", self: 1 });
  });

  it("routes rtc.signal only to the target slot, stamped with the sender", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = r.handle("c1", { t: "rtc.signal", to: 1, sdp: { type: "offer" } });
    expect(out).toEqual([
      {
        connectionId: "c2",
        message: { t: "rtc.signal", from: 0, to: 1, sdp: { type: "offer" } },
      },
    ]);
  });

  it("overwrites a client-supplied from with the authoritative sender slot", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = r.handle("c2", {
      t: "rtc.signal",
      from: 0,
      to: 0,
      sdp: { type: "answer" },
    });
    expect(out).toEqual([
      {
        connectionId: "c1",
        message: { t: "rtc.signal", from: 1, to: 0, sdp: { type: "answer" } },
      },
    ]);
  });

  it("reports an unknown target slot", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = r.handle("c1", { t: "rtc.signal", to: 3 });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "unknown_peer" });
  });

  it("rejects joining a second room on the same connection", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = r.handle("c1", {
      t: "room.join",
      room: "other",
      role: "player",
      token: "alice",
    });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "already_joined" });
  });

  it("broadcasts the host's game.start and flips status to playing", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));

    const out = r.handle("c1", { t: "game.start", startFrame: 0, inputDelay: 2 });

    const starts = out.filter((o) => o.message.t === "game.start");
    expect(starts.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    const states = out.filter((o) => o.message.t === "room.state");
    expect(states.map((o) => o.connectionId).sort()).toEqual(["c1", "c2"]);
    for (const state of states) {
      expect(state.message).toMatchObject({ t: "room.state", status: "playing" });
    }
  });

  it("rejects game.start from a non-host player", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = r.handle("c2", { t: "game.start", startFrame: 0, inputDelay: 2 });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "not_host" });
  });

  it("marks T22-unowned client types as unsupported", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    const out = r.handle("c1", { t: "chat", text: "hi" });
    expect(out[0]?.message).toMatchObject({ t: "error", code: "unsupported" });
  });

  it("broadcasts the room without a leaver on disconnect", () => {
    const r = relay();
    r.handle("c1", join("c1", "alice"));
    r.handle("c2", join("c2", "bob"));
    const out = byConnection(r.leave("c2"));
    expect(Object.keys(out)).toEqual(["c1"]);
    expect(out.c1?.message).toMatchObject({
      t: "room.state",
      players: [{ slot: 0, name: "player" }],
    });
  });

  it("ignores leave for an unknown connection", () => {
    expect(relay().leave("ghost")).toEqual([]);
  });
});
