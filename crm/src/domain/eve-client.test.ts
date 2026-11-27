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

  it("matches legacy bare part ids so a same-session reply is not duplicated", () => {
    // Rows persisted by pre-scoped builds carry the bare part id (`part_0`
    // here); the session-scoped replay of the same turn dedupes against them.
    const parsed = parseEveStream(V27_TWO_TURN_REPLAY, { sessionId: "wrun_A" });
    expect(findMissingEveMessages(new Set(["part_0"]), parsed.messages)).toEqual([
      { id: "wrun_A:part_1", text: "SEGUNDO" },
    ]);
  });

  it("never drops a new turn for repeating an old reply's text", () => {
    // Two turns legitimately answered the same words: ids decide, not text.
    const messages = [
      { id: "wrun_A:part_0", text: "Listo." },
      { id: "wrun_A:part_1", text: "Listo." },
    ];
    expect(findMissingEveMessages(new Set(["wrun_A:part_0"]), messages)).toEqual([
      { id: "wrun_A:part_1", text: "Listo." },
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

  it("returns deliveryId from createEveSession when eve 1.x provides one", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(202, { ok: true, sessionId: "wrun_V27", deliveryId: "d-0" })
    );
    const result = await createEveSession(
      { baseUrl, auth, message: "hola", operationId: "crm-thread-1" },
      fetchImpl
    );
    expect(result).toEqual({ sessionId: "wrun_V27", deliveryId: "d-0" });
  });
});

/**
 * EVE 1.x (stream version 27) fixtures: commit lines `{ at, facts }`,
 * progress records `{ progress }`, and transport records `{ $eve }`.
 */
const V27_TURN_0 = [
  '{"at":"2026-11-26T20:00:00.000Z","facts":[{"type":"session.started","data":{"runtime":{"eveVersion":"1.1.0"}}},{"type":"delivery.admitted","data":{"deliveryId":"d-0"}}]}',
  '{"at":"2026-11-26T20:00:00.010Z","facts":[{"type":"turn.started","scope":{"turnId":"turn_0"},"data":{"turnId":"turn_0","cause":{"deliveryId":"d-0"},"follows":null}},{"type":"delivery.consumed","scope":{"turnId":"turn_0"},"data":{"deliveryId":"d-0","turnId":"turn_0","parts":[{"kind":"text","text":"hola"}]}}]}',
  '{"at":"2026-11-26T20:00:00.020Z","facts":[{"type":"model.requested","scope":{"turnId":"turn_0"},"data":{"runId":"run_0","owner":{"turnId":"turn_0"}}}]}',
  '{"$eve":"heartbeat"}',
  '{"progress":{"type":"content.delta","scope":{"turnId":"turn_0","runId":"run_0"},"data":{"partId":"part_reason","kind":"reasoning","delta":"pensando..."}}}',
  '{"at":"2026-11-26T20:00:00.500Z","facts":[{"type":"content.completed","scope":{"turnId":"turn_0","runId":"run_0"},"data":{"partId":"part_reason","runId":"run_0","kind":"reasoning","phase":"narration","value":"pensando..."}}]}',
  '{"at":"2026-11-26T20:00:00.600Z","facts":[{"type":"content.completed","scope":{"turnId":"turn_0","runId":"run_0"},"data":{"partId":"part_narr","runId":"run_0","kind":"text","phase":"narration","value":"Consultando CRM..."}}]}',
  '{"progress":{"type":"content.delta","scope":{"turnId":"turn_0","runId":"run_0"},"data":{"partId":"part_0","kind":"text","delta":"V27-"}}}',
  '{"progress":{"type":"content.delta","scope":{"turnId":"turn_0","runId":"run_0"},"data":{"partId":"part_0","delta":"OK"}}}',
  '{"at":"2026-11-26T20:00:01.000Z","facts":[{"type":"content.completed","scope":{"turnId":"turn_0","runId":"run_0"},"data":{"partId":"part_0","runId":"run_0","kind":"text","phase":"reply","value":"V27-OK"}}]}',
  '{"at":"2026-11-26T20:00:01.010Z","facts":[{"type":"turn.settled","scope":{"turnId":"turn_0"},"data":{"turnId":"turn_0","outcome":"completed","reply":["part_0"]}},{"type":"delivery.settled","data":{"deliveryId":"d-0","outcome":"handled","turnId":"turn_0"}}]}',
].join("\n");

const V27_TWO_TURN_REPLAY = [
  V27_TURN_0,
  '{"at":"2026-11-26T20:01:00.000Z","facts":[{"type":"delivery.admitted","data":{"deliveryId":"d-1"}}]}',
  '{"at":"2026-11-26T20:01:00.010Z","facts":[{"type":"turn.started","scope":{"turnId":"turn_1"},"data":{"turnId":"turn_1","cause":{"deliveryId":"d-1"},"follows":"turn_0"}},{"type":"delivery.consumed","scope":{"turnId":"turn_1"},"data":{"deliveryId":"d-1","turnId":"turn_1","parts":[{"kind":"text","text":"segundo"}]}}]}',
  '{"progress":{"type":"content.delta","scope":{"turnId":"turn_1","runId":"run_1"},"data":{"partId":"part_1","kind":"text","delta":"SEGUNDO"}}}',
  '{"at":"2026-11-26T20:01:01.000Z","facts":[{"type":"content.completed","scope":{"turnId":"turn_1","runId":"run_1"},"data":{"partId":"part_1","runId":"run_1","kind":"text","phase":"reply","value":"SEGUNDO"}}]}',
  '{"at":"2026-11-26T20:01:01.010Z","facts":[{"type":"turn.settled","scope":{"turnId":"turn_1"},"data":{"turnId":"turn_1","outcome":"completed","reply":["part_1"]}},{"type":"delivery.settled","data":{"deliveryId":"d-1","outcome":"handled","turnId":"turn_1"}}]}',
].join("\n");

/**
 * Real eve 1.1 capture of a delegated turn (orchestrator → `strategist`),
 * trimmed: the child's spend arrives in the parent stream as a
 * `usage.recorded` owned by the call, before the turn settles.
 */
const V27_DELEGATED_TURN = [
  '{"at":"2026-11-27T00:00:00.000Z","facts":[{"type":"turn.started","scope":{"turnId":"turn_0"},"data":{"turnId":"turn_0","cause":{"deliveryId":"d-del"},"follows":null}},{"type":"delivery.consumed","scope":{"turnId":"turn_0"},"data":{"deliveryId":"d-del","turnId":"turn_0","parts":[]}}]}',
  '{"at":"2026-11-27T00:00:01.000Z","facts":[{"type":"model.settled","scope":{"runId":"run_0","turnId":"turn_0"},"data":{"finishReason":"tool-calls","outcome":"completed","runId":"run_0"}},{"type":"usage.recorded","scope":{"runId":"run_0","turnId":"turn_0"},"data":{"kind":"model","owner":{"runId":"run_0"},"usage":{"cacheReadTokens":0,"cacheWriteTokens":0,"inputTokens":20066,"outputTokens":381}}}]}',
  '{"at":"2026-11-27T00:00:03.000Z","facts":[{"type":"model.settled","scope":{"runId":"run_1","turnId":"turn_0"},"data":{"finishReason":"tool-calls","outcome":"completed","runId":"run_1"}},{"type":"usage.recorded","scope":{"runId":"run_1","turnId":"turn_0"},"data":{"kind":"model","owner":{"runId":"run_1"},"usage":{"cacheReadTokens":18026,"cacheWriteTokens":0,"inputTokens":20543,"outputTokens":33}}}]}',
  '{"at":"2026-11-27T00:00:05.000Z","facts":[{"type":"call.settled","scope":{"taskId":"strategist-7cr0k2","runId":"run_0","turnId":"turn_0"},"data":{"callId":"call_1","outcome":"completed","output":"recibido"}},{"type":"usage.recorded","scope":{"taskId":"strategist-7cr0k2","runId":"run_0","turnId":"turn_0"},"data":{"kind":"model","owner":{"callId":"call_1"},"usage":{"cacheReadTokens":0,"cacheWriteTokens":0,"inputTokens":2697,"outputTokens":144}}}]}',
  '{"at":"2026-11-27T00:00:06.000Z","facts":[{"type":"content.completed","scope":{"runId":"run_2","turnId":"turn_0"},"data":{"kind":"text","partId":"run_2.0","phase":"reply","runId":"run_2","value":"El subagente respondió \\"recibido\\"."}},{"type":"model.settled","scope":{"runId":"run_2","turnId":"turn_0"},"data":{"finishReason":"stop","outcome":"completed","runId":"run_2"}},{"type":"usage.recorded","scope":{"runId":"run_2","turnId":"turn_0"},"data":{"kind":"model","owner":{"runId":"run_2"},"usage":{"cacheReadTokens":18507,"cacheWriteTokens":0,"inputTokens":20687,"outputTokens":71}}}]}',
  '{"at":"2026-11-27T00:00:06.100Z","facts":[{"type":"turn.settled","scope":{"turnId":"turn_0"},"data":{"outcome":"completed","reply":["run_2.0"],"turnId":"turn_0"}},{"type":"delivery.settled","data":{"deliveryId":"d-del","outcome":"handled","turnId":"turn_0"}}]}',
  // A later turn in the same session: its spend must stay out of turn_0's.
  '{"at":"2026-11-27T00:01:00.000Z","facts":[{"type":"turn.started","scope":{"turnId":"turn_1"},"data":{"turnId":"turn_1","cause":{"deliveryId":"d-next"},"follows":"turn_0"}},{"type":"delivery.consumed","scope":{"turnId":"turn_1"},"data":{"deliveryId":"d-next","turnId":"turn_1","parts":[]}}]}',
  '{"at":"2026-11-27T00:01:02.000Z","facts":[{"type":"content.completed","scope":{"runId":"run_3","turnId":"turn_1"},"data":{"kind":"text","partId":"run_3.0","phase":"reply","runId":"run_3","value":"Otra respuesta"}},{"type":"usage.recorded","scope":{"runId":"run_3","turnId":"turn_1"},"data":{"kind":"model","owner":{"runId":"run_3"},"usage":{"cacheReadTokens":0,"cacheWriteTokens":64,"inputTokens":1000,"outputTokens":10}}},{"type":"turn.settled","scope":{"turnId":"turn_1"},"data":{"outcome":"completed","reply":["run_3.0"],"turnId":"turn_1"}},{"type":"delivery.settled","data":{"deliveryId":"d-next","outcome":"handled","turnId":"turn_1"}}]}',
].join("\n");

describe("parseEveStream (v27 / eve 1.x)", () => {
  it("parses a full v27 turn, ignoring reasoning and narration parts", () => {
    const parsed = parseEveStream(V27_TURN_0, { deliveryId: "d-0" });
    expect(parsed.text).toBe("V27-OK");
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.sessionWaiting).toBe(false);
    expect(parsed.turnId).toBe("turn_0");
    expect(parsed.messages).toEqual([{ id: "part_0", text: "V27-OK" }]);
    // No usage.recorded fact in the stream: the spend is unknown, not zero.
    expect(parsed.usage).toBeNull();
  });

  it("sums a turn's usage.recorded facts, delegated spend included", () => {
    const parsed = parseEveStream(V27_DELEGATED_TURN, { deliveryId: "d-del" });
    expect(parsed.usage).toEqual({
      inputTokens: 20066 + 20543 + 2697 + 20687,
      outputTokens: 381 + 33 + 144 + 71,
      cacheReadTokens: 0 + 18026 + 0 + 18507,
      cacheWriteTokens: 0,
    });
  });

  it("keeps a later turn's spend out of the scoped one, and sums all on unscoped reads", () => {
    const later = parseEveStream(V27_DELEGATED_TURN, { deliveryId: "d-next" });
    expect(later.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 64,
    });
    const wholeSession = parseEveStream(V27_DELEGATED_TURN);
    expect(wholeSession.usage?.inputTokens).toBe(20066 + 20543 + 2697 + 20687 + 1000);
  });

  it("scopes message ids to the session when sessionId is given", () => {
    // Part ids restart at run_0 in every session, so a thread whose session
    // was replaced would otherwise drop its next reply as already persisted.
    const scoped = parseEveStream(V27_TWO_TURN_REPLAY, {
      deliveryId: "d-1",
      sessionId: "wrun_A",
    });
    expect(scoped.messages).toEqual([{ id: "wrun_A:part_1", text: "SEGUNDO" }]);
    const history = parseEveStream(V27_TWO_TURN_REPLAY, { sessionId: "wrun_A" });
    expect(history.messages.map((m) => m.id)).toEqual(["wrun_A:part_0", "wrun_A:part_1"]);
  });

  it("concatenates text content.delta records before content.completed arrives", () => {
    const partial = V27_TURN_0.split("\n").slice(0, 9).join("\n");
    const parsed = parseEveStream(partial, { deliveryId: "d-0" });
    expect(parsed.text).toBe("V27-OK");
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.messages).toEqual([]);
  });

  it("scopes a replayed v27 follow-up turn to its deliveryId", () => {
    const parsed = parseEveStream(V27_TWO_TURN_REPLAY, { deliveryId: "d-1" });
    expect(parsed.text).toBe("SEGUNDO");
    expect(parsed.messages).toEqual([{ id: "part_1", text: "SEGUNDO" }]);
    expect(parsed.turnId).toBe("turn_1");
    expect(parsed.turnCompleted).toBe(true);
  });

  it("keeps the replayed v27 prefix open while the follow-up delivery has not settled", () => {
    const parsed = parseEveStream(V27_TURN_0, { deliveryId: "d-1" });
    expect(parsed.turnCompleted).toBe(false);
    expect(parsed.sessionWaiting).toBe(false);
    expect(parsed.messages).toEqual([]);
  });

  it("collects all completed replies on unscoped v27 reads for history sync", () => {
    const parsed = parseEveStream(V27_TWO_TURN_REPLAY);
    expect(parsed.messages).toEqual([
      { id: "part_0", text: "V27-OK" },
      { id: "part_1", text: "SEGUNDO" },
    ]);
    expect(parsed.text).toBe("V27-OK\n\nSEGUNDO");
    expect(parsed.turnId).toBe("turn_1");
    expect(parsed.turnCompleted).toBe(true);
  });

  it("surfaces turn.settled failures as parsed.error with turnCompleted=true", () => {
    const failed = [
      '{"at":"2026-11-26T20:00:00.000Z","facts":[{"type":"turn.started","scope":{"turnId":"turn_0"},"data":{"turnId":"turn_0","cause":{"deliveryId":"d-0"},"follows":null}},{"type":"delivery.consumed","scope":{"turnId":"turn_0"},"data":{"deliveryId":"d-0","turnId":"turn_0","parts":[{"kind":"text","text":"hola"}]}}]}',
      '{"at":"2026-11-26T20:00:01.000Z","facts":[{"type":"turn.settled","scope":{"turnId":"turn_0"},"data":{"turnId":"turn_0","outcome":"failed","error":{"code":"MODEL_CALL_FAILED","message":"Rate limit exceeded"}}},{"type":"delivery.settled","data":{"deliveryId":"d-0","outcome":"handled","turnId":"turn_0"}}]}',
    ].join("\n");
    const parsed = parseEveStream(failed, { deliveryId: "d-0" });
    expect(parsed.turnCompleted).toBe(true);
    expect(parsed.error).toEqual({
      code: "MODEL_CALL_FAILED",
      message: "Rate limit exceeded",
    });
  });
});

describe("eve transport (v27 / eve 1.x)", () => {
  const baseUrl = "http://127.0.0.1:3000";
  const auth = { username: "u", password: "p" };

  it("reconnects with startIndex when eve sends stream.lease-ended mid-turn", async () => {
    const lines = V27_TURN_0.split("\n");
    // First lease: 3 stored lines + heartbeat + lease-ended (heartbeat is not a stored line)
    const lease1 = [...lines.slice(0, 4), '{"$eve":"stream.lease-ended"}'].join("\n") + "\n";
    const lease2 = lines.slice(4).join("\n") + "\n";

    let callCount = 0;
    const fetchImpl = fakeFetch((url) => {
      callCount += 1;
      if (callCount === 1) {
        expect(url).toBe(`${baseUrl}/eve/v1/session/wrun_V27/stream`);
        return chunkedNdjsonResponse([lease1]);
      }
      expect(url).toBe(`${baseUrl}/eve/v1/session/wrun_V27/stream?startIndex=3`);
      return chunkedNdjsonResponse([lease2]);
    });

    const raw = await readEveStreamToTerminal(
      { baseUrl, auth, sessionId: "wrun_V27", deliveryId: "d-0" },
      fetchImpl
    );
    expect(callCount).toBe(2);
    const parsed = parseEveStream(raw, { deliveryId: "d-0" });
    expect(parsed.text).toBe("V27-OK");
    expect(parsed.turnCompleted).toBe(true);
  });

  it("reads all recorded turns to EOF when follow=false", async () => {
    const lines = V27_TWO_TURN_REPLAY.split("\n");
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe(`${baseUrl}/eve/v1/session/wrun_V27/stream?follow=false`);
      return chunkedNdjsonResponse([
        lines.slice(0, 11).join("\n") + "\n",
        lines.slice(11).join("\n") + "\n",
      ]);
    });

    const raw = await readEveStreamToTerminal(
      { baseUrl, auth, sessionId: "wrun_V27", follow: false },
      fetchImpl
    );
    const parsed = parseEveStream(raw);
    expect(parsed.messages).toEqual([
      { id: "part_0", text: "V27-OK" },
      { id: "part_1", text: "SEGUNDO" },
    ]);
  });
});
