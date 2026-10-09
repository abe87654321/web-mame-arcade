import { describe, expect, it, vi } from "vitest";
import { createRelayClient } from "./relay-client";
import { FakeWebSocket, fakeSocketFactory } from "./test-fakes";

function makeClient() {
  const socket = new FakeWebSocket();
  const onMessage = vi.fn();
  const client = createRelayClient({
    url: "ws://relay.test/ws",
    join: { room: "r1", role: "player", token: "jwt" },
    socketFactory: fakeSocketFactory(socket),
    onMessage,
  });
  return { socket, onMessage, client };
}

describe("createRelayClient", () => {
  it("joins the room when the socket opens", () => {
    const { socket } = makeClient();

    socket.open();

    expect(socket.sent).toEqual([
      JSON.stringify({ t: "room.join", room: "r1", role: "player", token: "jwt" }),
    ]);
  });

  it("parses and forwards well-formed server messages", () => {
    const { socket, onMessage } = makeClient();

    socket.emitMessage(JSON.stringify({ t: "chat", text: "gg" }));

    expect(onMessage).toHaveBeenCalledWith({ t: "chat", text: "gg" });
  });

  it("ignores malformed JSON and unknown message types", () => {
    const { socket, onMessage } = makeClient();

    expect(() => socket.emitMessage("{not json")).not.toThrow();
    socket.emitMessage(JSON.stringify({ t: "nope" }));

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("sends client messages while open and refuses once closed", () => {
    const { socket, client } = makeClient();
    socket.open();

    expect(client.send({ t: "chat", text: "hi" })).toBe(true);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: "chat", text: "hi" }));

    client.close();
    expect(socket.closes).toBe(1);
    expect(client.send({ t: "chat", text: "late" })).toBe(false);
  });

  it("does not send before the socket opens", () => {
    const { client } = makeClient();

    expect(client.send({ t: "chat", text: "early" })).toBe(false);
  });
});
