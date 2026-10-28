import { describe, expect, it } from "vitest";
import {
  EveClientError,
  basicAuthHeader,
  createEveSession,
  findMissingEveMessages,
  parseEveStream,
  readEveStreamToTerminal,
  resolveEveProxyConfig,
  sendEveMessage,
} from "./eve-client";

/**
 * Thin-proxy domain for delegating the macOS chat to the EVE brain.
 * Pure parsing + injectable transport: no network, no DB in these tests.
 * Fixtures mirror the real /eve/v1 NDJSON shapes observed in the spike.
 */

const FULL_TURN = [
  '{"data":{"runtime":{"agentId":"eve-agent","agentName":"eve-agent","eveVersion":"0.79.0"}},"type":"session.started","meta":{"at":"2026-10-15T21:50:52.342Z","id":"evt_start","deliveryIds":["d-0"]}}',
  '{"data":{"sequence":0,"turnId":"turn_0"},"type":"turn.started","meta":{"at":"2026-10-15T21:50:52.344Z","id":"evt_turn","deliveryIds":["d-0"]}}',
  '{"data":{"message":"hola","parts":[{"text":"hola","type":"text"}],"sequence":0,"turnId":"turn_0"},"type":"message.received","meta":{"at":"2026-10-15T21:50:52.344Z","id":"evt_recv","deliveryIds":["d-0"]}}',
  '{"data":{"modelId":"meta-subscription/muse-spark-1.3-contributor","sequence":0,"stepIndex":0,"turnId":"turn_0"},"type":"step.started","meta":{"at":"2026-10-15T21:50:52.344Z","id":"evt_step","deliveryIds":["d-0"]}}',
  '{"data":{"messageDelta":"SPIKE-","sequence":0,"stepIndex":0,"turnId":"turn_0"},"type":"message.appended","meta":{"at":"2026-10-15T21:50:55.600Z","id":"evt_d1","deliveryIds":["d-0"]}}',
  '{"data":{"messageDelta":"OK","sequence":0,"stepIndex":0,"turnId":"turn_0"},"type":"message.appended","meta":{"at":"2026-10-15T21:50:55.668Z","id":"evt_d2","deliveryIds":["d-0"]}}',
  '{"data":{"finishReason":"stop","message":"SPIKE-OK","sequence":0,"stepIndex":0,"turnId":"turn_0"},"type":"message.completed","meta":{"at":"2026-10-15T21:50:55.981Z","id":"evt_msg","deliveryIds":["d-0"]}}',
  '{"data":{"finishReason":"stop","sequence":0,"stepIndex":0,"turnId":"turn_0","usage":{"inputTokens":6355,"outputTokens":46}},"type":"step.completed","meta":{"at":"2026-10-15T21:50:55.983Z","id":"evt_stepdone","deliveryIds":["d-0"]}}',
  '{"data":{"sequence":0,"turnId":"turn_0"},"type":"turn.completed","meta":{"at":"2026-10-15T21:50:55.987Z","id":"evt_turndone","deliveryIds":["d-0"]}}',
  '{"data":{"continuationToken":"wrun_ABC","usage":{"inputTokens":6355,"outputTokens":46},"wait":"next-user-message"},"type":"session.waiting","meta":{"at":"2026-10-15T21:50:55.987Z","id":"evt_wait","deliveryIds":["d-0"]}}',
].join("\n");

/**
 * Real follow-up shape (observed live against eve 0.79.0, stream version 26):
 * opening the stream without a cursor replays the whole session, so the
 * previous turn's events — including its turn.completed/session.waiting —
 * arrive before the new turn's. Events carry meta.deliveryIds naming the
 * accepted message that owns the turn, and the follow-up POST response
 * returns that deliveryId.
 */
const TWO_TURN_REPLAY = [
  FULL_TURN,
  '{"data":{"sequence":1,"turnId":"turn_1"},"type":"turn.started","meta":{"at":"2026-10-15T21:51:10.000Z","id":"evt_turn2","deliveryIds":["d-1"]}}',
  '{"data":{"message":"segundo","parts":[{"text":"segundo","type":"text"}],"sequence":1,"turnId":"turn_1"},"type":"message.received","meta":{"at":"2026-10-15T21:51:10.001Z","id":"evt_recv2","deliveryIds":["d-1"]}}',
  '{"data":{"modelId":"meta-subscription/muse-spark-1.3-contributor","sequence":1,"stepIndex":0,"turnId":"turn_1"},"type":"step.started","meta":{"at":"2026-10-15T21:51:10.002Z","id":"evt_step2","deliveryIds":["d-1"]}}',
  '{"data":{"messageDelta":"SEG","sequence":1,"stepIndex":0,"turnId":"turn_1"},"type":"message.appended","meta":{"at":"2026-10-15T21:51:12.100Z","id":"evt_d3","deliveryIds":["d-1"]}}',
  '{"data":{"messageDelta":"UNDO","sequence":1,"stepIndex":0,"turnId":"turn_1"},"type":"message.appended","meta":{"at":"2026-10-15T21:51:12.200Z","id":"evt_d4","deliveryIds":["d-1"]}}',
  '{"data":{"finishReason":"stop","message":"SEGUNDO","sequence":1,"stepIndex":0,"turnId":"turn_1"},"type":"message.completed","meta":{"at":"2026-10-15T21:51:12.300Z","id":"evt_msg2","deliveryIds":["d-1"]}}',
  '{"data":{"finishReason":"stop","sequence":1,"stepIndex":0,"turnId":"turn_1","usage":{"inputTokens":6400,"outputTokens":8}},"type":"step.completed","meta":{"at":"2026-10-15T21:51:12.310Z","id":"evt_stepdone2","deliveryIds":["d-1"]}}',
  '{"data":{"sequence":1,"turnId":"turn_1"},"type":"turn.completed","meta":{"at":"2026-10-15T21:51:12.320Z","id":"evt_turndone2","deliveryIds":["d-1"]}}',
  '{"data":{"continuationToken":"wrun_ABC","usage":{"inputTokens":6400,"outputTokens":8},"wait":"next-user-message"},"type":"session.waiting","meta":{"at":"2026-10-15T21:51:12.330Z","id":"evt_wait2","deliveryIds":["d-1"]}}',
].join("\n");

const fakeFetch = (
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>
): typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> } => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Streams the given ndjson chunks as separate reader reads, mirroring how the
 * live endpoint delivers a replayed prefix first and the new turn later.
 */
const chunkedNdjsonResponse = (chunks: string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson" } }
  );

describe("parseEveStream", () => {
  it("parses a full turn: text, terminal flags, turn id and message ids", () => {
    const parsed = parseEveStream(FULL_TURN);
    expect(parsed.text).toBe("SPIKE-OK");
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.sessionWaiting).toBe(true);
    expect(parsed.turnId).toBe("turn_0");
    expect(parsed.messages).toEqual([{ id: "evt_msg", text: "SPIKE-OK" }]);
  });

  it("concatenates deltas when no message.completed arrived yet", () => {
    const partial = FULL_TURN.split("\n").slice(0, 6).join("\n");
    const parsed = parseEveStream(partial);
    expect(parsed.text).toBe("SPIKE-OK");
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.messages).toEqual([]);
  });

  it("ignores the user echo and malformed lines", () => {
    const parsed = parseEveStream(
      ['not json at all', "", "   ", FULL_TURN.split("\n")[2]].join("\n")
    );
    expect(parsed.text).toBe("");
    expect(parsed.messages).toEqual([]);
    expect(parsed.turnCompleted).toBe(false);
  });

  it("reports non-terminal streams as open", () => {
    const parsed = parseEveStream(FULL_TURN.split("\n").slice(0, 4).join("\n"));
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.sessionWaiting).toBe(false);
  });

  it("parses a replayed follow-up turn scoped to the delivery that owns it", () => {
    const parsed = parseEveStream(TWO_TURN_REPLAY, { deliveryId: "d-1" });
    expect(parsed.text).toBe("SEGUNDO");
    expect(parsed.messages).toEqual([{ id: "evt_msg2", text: "SEGUNDO" }]);
    expect(parsed.turnId).toBe("turn_1");
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.sessionWaiting).toBe(true);
  });

  it("keeps the replayed prefix open while the new turn has not settled", () => {
    // Only the previous turn (with its terminal events) has been replayed so
    // far; the follow-up's events have not arrived. Scoped parsing must not
    // mistake the old turn.completed for this turn's terminal.
    const partial = TWO_TURN_REPLAY.split("\n").slice(0, 10).join("\n");
    const parsed = parseEveStream(partial, { deliveryId: "d-1" });
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.sessionWaiting).toBe(false);
    expect(parsed.messages).toEqual([]);
  });

  it("pins unscoped parsing of a replayed stream for history sync", () => {
    const parsed = parseEveStream(TWO_TURN_REPLAY);
    expect(parsed.messages.map((m) => m.text)).toEqual(["SPIKE-OK", "SEGUNDO"]);
    // Multi-message turns are joined with a paragraph break (see parseEveStream).
    expect(parsed.text).toBe("SPIKE-OK\n\nSEGUNDO");
    expect(parsed.turnId).toBe("turn_1");
  });
});

describe("resolveEveProxyConfig", () => {
  it("enables the proxy when url, user and password are present", () => {
    const config = resolveEveProxyConfig({
      EVE_AGENT_URL: "http://127.0.0.1:3000/",
      EVE_CHANNEL_USER: "u",
      EVE_CHANNEL_PASSWORD: "p",
    });
    expect(config).toEqual({
      enabled: true,
      baseUrl: "http://127.0.0.1:3000",
      username: "u",
      password: "p",
    });
  });

  it("stays disabled when any piece is missing", () => {
    expect(
      resolveEveProxyConfig({ EVE_CHANNEL_USER: "u", EVE_CHANNEL_PASSWORD: "p" }).enabled
    ).toBe(false);
    expect(
      resolveEveProxyConfig({ EVE_AGENT_URL: "http://x", EVE_CHANNEL_USER: "u" }).enabled
    ).toBe(false);
    expect(resolveEveProxyConfig({}).enabled).toBe(false);
  });

  it("builds a Basic auth header", () => {
    expect(basicAuthHeader("u", "p")).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });
});

describe("findMissingEveMessages", () => {
  it("returns only messages whose event id is not persisted yet", () => {
    const parsed = parseEveStream(FULL_TURN);
    expect(findMissingEveMessages(new Set(["evt_msg"]), parsed.messages)).toEqual([]);
    expect(findMissingEveMessages(new Set(), parsed.messages)).toEqual([
      { id: "evt_msg", text: "SPIKE-OK" },
    ]);
  });
});

describe("eve transport", () => {
  const baseUrl = "http://127.0.0.1:3000";
  const auth = { username: "u", password: "p" };

  it("creates a session with message + operationId and returns the session id", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe(`${baseUrl}/eve/v1/session`);
      return jsonResponse(200, { ok: true, sessionId: "wrun_X", status: "accepted" });
    });
    const result = await createEveSession(
      { baseUrl, auth, message: "hola", operationId: "crm-thread-1" },
      fetchImpl
    );
    expect(result).toEqual({ sessionId: "wrun_X" });
    const sent = fetchImpl.calls[0]?.init;
    expect(sent?.method).toBe("POST");
    expect((sent?.headers as Record<string, string>)?.Authorization).toMatch(/^Basic \S+$/);
    const body = JSON.parse(String(sent?.body));
    expect(body).toMatchObject({ message: "hola", operationId: "crm-thread-1" });
  });

  it("throws EveClientError with status on auth failure", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(401, { ok: false, code: "unauthorized" })
    );
    await expect(
      createEveSession({ baseUrl, auth, message: "hola" }, fetchImpl)
    ).rejects.toMatchObject({ name: "EveClientError", status: 401 });
  });

  it("sends follow-up messages to an existing session and returns its delivery id", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe(`${baseUrl}/eve/v1/session/wrun_X`);
      return jsonResponse(200, { ok: true, status: "accepted", deliveryId: "d-1" });
    });
    const sent = await sendEveMessage(
      { baseUrl, auth, sessionId: "wrun_X", message: "segundo" },
      fetchImpl
    );
    expect(sent).toEqual({ deliveryId: "d-1" });
    const body = JSON.parse(String(fetchImpl.calls[0]?.init?.body));
    expect(body).toMatchObject({ message: "segundo" });
  });

  it("tolerates follow-up responses without a delivery id", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, { ok: true, status: "accepted" }));
    const sent = await sendEveMessage(
      { baseUrl, auth, sessionId: "wrun_X", message: "segundo" },
      fetchImpl
    );
    expect(sent).toEqual({});
  });

  it("surfaces eve 409 codes for dead sessions", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(409, { ok: false, code: "session_not_active" })
    );
    await expect(
      sendEveMessage({ baseUrl, auth, sessionId: "wrun_DEAD", message: "hola" }, fetchImpl)
    ).rejects.toMatchObject({ name: "EveClientError", status: 409, code: "session_not_active" });
  });

  it("reads the stream until a terminal event and stops", async () => {
    const fetchImpl = fakeFetch(() => new Response(FULL_TURN + "\n"));
    const raw = await readEveStreamToTerminal(
      { baseUrl, auth, sessionId: "wrun_X" },
      fetchImpl
    );
    expect(parseEveStream(raw).text).toBe("SPIKE-OK");
  });

  it("waits for the terminal of the scoped follow-up turn, not the replayed one", async () => {
    const lines = TWO_TURN_REPLAY.split("\n");
    const fetchImpl = fakeFetch(() =>
      chunkedNdjsonResponse([lines.slice(0, 10).join("\n") + "\n", lines.slice(10).join("\n") + "\n"])
    );
    const raw = await readEveStreamToTerminal(
      { baseUrl, auth, sessionId: "wrun_X", deliveryId: "d-1" },
      fetchImpl
    );
    const parsed = parseEveStream(raw, { deliveryId: "d-1" });
    expect(parsed.text).toBe("SEGUNDO");
  });

  it("still stops at the replayed terminal when no delivery scope is given", async () => {
    // Pin of the (legacy) unscoped behavior: the reader stops at the first
    // terminal in the byte stream, which on a replayed follow-up belongs to
    // the previous turn. Callers that own a turn must pass deliveryId.
    const lines = TWO_TURN_REPLAY.split("\n");
    const fetchImpl = fakeFetch(() =>
      chunkedNdjsonResponse([lines.slice(0, 10).join("\n") + "\n", lines.slice(10).join("\n") + "\n"])
    );
    const raw = await readEveStreamToTerminal(
      { baseUrl, auth, sessionId: "wrun_X" },
      fetchImpl
    );
    const parsed = parseEveStream(raw);
    expect(parsed.text).toBe("SPIKE-OK");
    expect(parsed.messages.map((m) => m.text)).toEqual(["SPIKE-OK"]);
  });

  it("aborts the stream read when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = fakeFetch(() => new Response(FULL_TURN));
    await expect(
      readEveStreamToTerminal(
        { baseUrl, auth, sessionId: "wrun_X", signal: controller.signal },
        fetchImpl
      )
    ).rejects.toThrow();
  });
});
