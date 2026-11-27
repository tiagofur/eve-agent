/**
 * Thin-proxy client for delegating CRM/Telegram/public chat to the EVE brain.
 *
 * The CRM route stays dumb: it resolves/creates the thread, forwards the new
 * user message to an EVE session, awaits the turn to a terminal event, and
 * persists the reply. Transport is injectable so tests run without network;
 * production passes the global fetch.
 *
 * Supports EVE stream protocol v27 (eve 1.x: commit `{ at, facts }`, progress
 * `{ progress }`, and transport `{ $eve }` NDJSON lines with renewable leases)
 * while retaining compatibility with legacy v26 flat event envelopes.
 */

export interface EveAuth {
  username: string;
  password: string;
}

export type EveProxyConfig =
  | { enabled: true; baseUrl: string; username: string; password: string }
  | { enabled: false };

export type EnabledEveProxyConfig = Extract<EveProxyConfig, { enabled: true }>;

export function resolveEveProxyConfig(
  env: Record<string, string | undefined>
): EveProxyConfig {
  const baseUrl = (env.EVE_AGENT_URL ?? "").trim().replace(/\/+$/, "");
  const username = (env.EVE_CHANNEL_USER ?? "").trim();
  const password = env.EVE_CHANNEL_PASSWORD ?? "";
  if (!baseUrl || !username || !password) return { enabled: false };
  return { enabled: true, baseUrl, username, password };
}

/**
 * Credentials for PUBLIC visitor traffic (web chat). Deliberately separate
 * from the staff proxy above: eve marks this exact username as a public
 * principal and denies staff-only tools to it. There is no fallback to the
 * staff credential — if these are unset, public chat fails closed (503)
 * instead of silently authenticating visitors as staff.
 */
export function resolvePublicEveProxyConfig(
  env: Record<string, string | undefined>
): EveProxyConfig {
  const baseUrl = (env.EVE_AGENT_URL ?? "").trim().replace(/\/+$/, "");
  const username = (env.EVE_PUBLIC_USER ?? "").trim();
  const password = env.EVE_PUBLIC_PASSWORD ?? "";
  if (!baseUrl || !username || !password) return { enabled: false };
  return { enabled: true, baseUrl, username, password };
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export interface ParsedEveMessage {
  id: string;
  text: string;
}

export interface ParsedEveError {
  code?: string;
  message: string;
}

export interface ParsedEveStream {
  messages: ParsedEveMessage[];
  /** Full assistant text: completed messages, or concatenated deltas. */
  text: string;
  turnCompleted: boolean;
  sessionWaiting: boolean;
  turnId?: string;
  error?: ParsedEveError;
}

/**
 * Scoping options for replayed streams.
 *
 * The session stream is durable: opening it without a cursor replays every
 * recorded event, so a follow-up read sees the previous turn's events before
 * the new turn's. Passing the `deliveryId` returned by session create/send
 * keeps only the events of the turn that delivery owns.
 */
export interface ParseEveStreamOptions {
  deliveryId?: string;
  /**
   * Prefixes v27 message ids with the session. Part ids (`run_0.0`) are only
   * unique within one session, and a thread's session is replaced whenever
   * the old one dies: unprefixed, the first reply of a replacement session
   * reads as already persisted and is dropped.
   */
  sessionId?: string;
}

interface RawEnvelope {
  type?: unknown;
  data?: unknown;
  scope?: unknown;
  meta?: unknown;
  at?: unknown;
  facts?: unknown;
  progress?: unknown;
  $eve?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseErrorInfo(value: unknown): ParsedEveError | undefined {
  const obj = asRecord(value);
  const message = typeof obj.message === "string" ? obj.message : undefined;
  const code = typeof obj.code === "string" ? obj.code : undefined;
  if (!message && !code) return undefined;
  return {
    ...(code ? { code } : {}),
    message: message ?? code ?? "EVE turn failed",
  };
}

function eventBelongsToDeliveryV26(evt: RawEnvelope, deliveryId?: string): boolean {
  if (!deliveryId) return true;
  const meta = asRecord(evt.meta);
  const ids = Array.isArray(meta.deliveryIds) ? meta.deliveryIds : [];
  return ids.includes(deliveryId);
}

interface V27Part {
  id: string;
  kind: string;
  phase: string;
  text: string;
  turnId?: string;
}

interface V27Delta {
  kind?: string;
  turnId?: string;
  chunks: string[];
}

interface V27DeliverySettlement {
  outcome: string;
  turnId?: string;
  reason?: string;
}

export function parseEveStream(
  ndjson: string,
  options?: ParseEveStreamOptions
): ParsedEveStream {
  // Legacy v26 accumulators
  const v26Messages: ParsedEveMessage[] = [];
  const v26Deltas: string[] = [];
  let v26TurnCompleted = false;
  let v26SessionWaiting = false;
  let v26TurnId: string | undefined;
  let counter = 0;

  // Stream v27 accumulators
  let sawV27 = false;
  const deliveryToTurn = new Map<string, string>();
  const runToTurn = new Map<string, string>();
  const v27Parts = new Map<string, V27Part>();
  const v27PartOrder: string[] = [];
  const v27Deltas = new Map<string, V27Delta>();
  const v27DeltaOrder: string[] = [];
  const v27TurnReplies = new Map<string, string[]>();
  const v27TurnOutcomes = new Map<string, string>();
  const v27TurnErrors = new Map<string, ParsedEveError>();
  const v27TurnPaused = new Set<string>();
  const v27DeliverySettlements = new Map<string, V27DeliverySettlement>();
  let v27SessionEnded = false;
  let v27SessionError: ParsedEveError | undefined;
  let v27LatestTurnId: string | undefined;

  const resolveTurnId = (
    scope: Record<string, unknown>,
    data: Record<string, unknown>
  ): string | undefined => {
    if (typeof scope.turnId === "string") return scope.turnId;
    if (typeof data.turnId === "string") return data.turnId;
    const runId =
      typeof data.runId === "string"
        ? data.runId
        : typeof scope.runId === "string"
          ? scope.runId
          : undefined;
    if (runId) return runToTurn.get(runId);
    return undefined;
  };

  const observeV27Fact = (rawFact: unknown) => {
    const fact = asRecord(rawFact);
    const type = typeof fact.type === "string" ? fact.type : "";
    if (!type) return;
    const data = asRecord(fact.data);
    const scope = asRecord(fact.scope);

    switch (type) {
      case "turn.started": {
        const turnId = typeof data.turnId === "string" ? data.turnId : undefined;
        if (turnId) {
          v27LatestTurnId = turnId;
          const cause = asRecord(data.cause);
          if (typeof cause.deliveryId === "string") {
            deliveryToTurn.set(cause.deliveryId, turnId);
          }
        }
        break;
      }
      case "delivery.consumed": {
        const deliveryId =
          typeof data.deliveryId === "string" ? data.deliveryId : undefined;
        const turnId = resolveTurnId(scope, data);
        if (deliveryId && turnId) {
          deliveryToTurn.set(deliveryId, turnId);
        }
        break;
      }
      case "delivery.settled": {
        const deliveryId =
          typeof data.deliveryId === "string" ? data.deliveryId : undefined;
        const outcome = typeof data.outcome === "string" ? data.outcome : "";
        const turnId = resolveTurnId(scope, data);
        const reason = typeof data.reason === "string" ? data.reason : undefined;
        if (deliveryId && outcome) {
          v27DeliverySettlements.set(deliveryId, { outcome, turnId, reason });
          if (turnId) deliveryToTurn.set(deliveryId, turnId);
        }
        break;
      }
      case "model.requested":
      case "model.started": {
        const runId = typeof data.runId === "string" ? data.runId : undefined;
        const owner = asRecord(data.owner);
        const turnId =
          typeof owner.turnId === "string"
            ? owner.turnId
            : typeof scope.turnId === "string"
              ? scope.turnId
              : undefined;
        if (runId && turnId) runToTurn.set(runId, turnId);
        break;
      }
      case "content.completed": {
        const partId =
          typeof data.partId === "string" ? data.partId : `part-${counter++}`;
        const kind = typeof data.kind === "string" ? data.kind : "text";
        const phase = typeof data.phase === "string" ? data.phase : "reply";
        const text = typeof data.value === "string" ? data.value : "";
        const turnId = resolveTurnId(scope, data);
        const id = options?.sessionId ? `${options.sessionId}:${partId}` : partId;
        if (!v27Parts.has(partId)) v27PartOrder.push(partId);
        v27Parts.set(partId, { id, kind, phase, text, turnId });
        break;
      }
      case "turn.paused": {
        const turnId = resolveTurnId(scope, data);
        const awaiting = Array.isArray(data.awaiting) ? data.awaiting : [];
        if (turnId && awaiting.length > 0) {
          v27TurnPaused.add(turnId);
        }
        break;
      }
      case "turn.settled": {
        const turnId = resolveTurnId(scope, data);
        const outcome = typeof data.outcome === "string" ? data.outcome : "";
        if (turnId) {
          v27LatestTurnId = turnId;
          if (outcome) v27TurnOutcomes.set(turnId, outcome);
          if (Array.isArray(data.reply)) {
            const replyIds = data.reply.filter(
              (id): id is string => typeof id === "string"
            );
            v27TurnReplies.set(turnId, replyIds);
          }
          if (outcome === "failed") {
            v27TurnErrors.set(
              turnId,
              parseErrorInfo(data.error) ?? {
                code: "TURN_FAILED",
                message: "EVE turn failed",
              }
            );
          }
        }
        break;
      }
      case "session.ended": {
        v27SessionEnded = true;
        if (data.outcome === "failed") {
          v27SessionError = parseErrorInfo(data.error) ?? {
            code: "SESSION_FAILED",
            message: "EVE session failed",
          };
        }
        break;
      }
      default:
        break;
    }
  };

  const observeV27Progress = (rawProgress: unknown) => {
    const progress = asRecord(rawProgress);
    const type = typeof progress.type === "string" ? progress.type : "";
    if (type !== "content.delta") return;
    const data = asRecord(progress.data);
    const scope = asRecord(progress.scope);
    const partId = typeof data.partId === "string" ? data.partId : "";
    const delta = typeof data.delta === "string" ? data.delta : "";
    if (!partId || !delta) return;
    const kind = typeof data.kind === "string" ? data.kind : undefined;
    const turnId = resolveTurnId(scope, data);
    const existing = v27Deltas.get(partId);
    if (existing) {
      existing.chunks.push(delta);
      if (kind && !existing.kind) existing.kind = kind;
      if (turnId && !existing.turnId) existing.turnId = turnId;
    } else {
      v27DeltaOrder.push(partId);
      v27Deltas.set(partId, { kind, turnId, chunks: [delta] });
    }
  };

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: RawEnvelope;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      evt = parsed as RawEnvelope;
    } catch {
      continue;
    }

    // v27 transport records (heartbeat, position, lease-ended, stream.ended)
    if (typeof evt.$eve === "string") {
      sawV27 = true;
      continue;
    }

    // v27 commit line: { at, facts: [...] }
    if (Array.isArray(evt.facts)) {
      sawV27 = true;
      for (const fact of evt.facts) observeV27Fact(fact);
      continue;
    }

    // v27 progress line: { progress: { type, scope?, data } }
    if (evt.progress && typeof evt.progress === "object" && !Array.isArray(evt.progress)) {
      sawV27 = true;
      observeV27Progress(evt.progress);
      continue;
    }

    // Legacy v26 flat event envelope
    if (!eventBelongsToDeliveryV26(evt, options?.deliveryId)) continue;

    const type = typeof evt.type === "string" ? evt.type : "";
    const data = asRecord(evt.data);
    const meta = asRecord(evt.meta);
    const metaId = typeof meta.id === "string" ? meta.id : `evt-${counter++}`;
    const eventTurnId = typeof data.turnId === "string" ? data.turnId : undefined;
    if (eventTurnId) v26TurnId = eventTurnId;

    switch (type) {
      case "message.completed": {
        const text = typeof data.message === "string" ? data.message : "";
        if (text) v26Messages.push({ id: metaId, text });
        break;
      }
      case "message.appended": {
        const delta = typeof data.messageDelta === "string" ? data.messageDelta : "";
        if (delta) v26Deltas.push(delta);
        break;
      }
      case "turn.completed":
        v26TurnCompleted = true;
        break;
      case "session.waiting":
        v26SessionWaiting = true;
        break;
      default:
        break;
    }
  }

  if (!sawV27) {
    return {
      messages: v26Messages,
      // Multi-message turns (status preamble + final answer) need a paragraph
      // break between messages; the streaming-deltas fallback stays unjoined.
      text:
        v26Messages.length > 0
          ? v26Messages.map((m) => m.text).join("\n\n")
          : v26Deltas.join(""),
      turnCompleted: v26TurnCompleted,
      sessionWaiting: v26SessionWaiting,
      turnId: v26TurnId,
    };
  }

  const targetDeliveryId = options?.deliveryId;
  const messages: ParsedEveMessage[] = [];
  const deltas: string[] = [];

  if (targetDeliveryId) {
    const settlement = v27DeliverySettlements.get(targetDeliveryId);
    const targetTurnId = settlement?.turnId ?? deliveryToTurn.get(targetDeliveryId);
    let turnCompleted = false;
    let sessionWaiting = false;
    let error: ParsedEveError | undefined;

    if (settlement) {
      turnCompleted = true;
      sessionWaiting = settlement.outcome === "awaiting-input";
      if (settlement.outcome === "failed" || settlement.outcome === "refused") {
        error =
          (targetTurnId ? v27TurnErrors.get(targetTurnId) : undefined) ?? {
            code:
              settlement.outcome === "refused"
                ? "DELIVERY_REFUSED"
                : "DELIVERY_FAILED",
            message: settlement.reason ?? `EVE delivery ${settlement.outcome}`,
          };
      }
    } else if (targetTurnId && v27TurnOutcomes.has(targetTurnId)) {
      turnCompleted = true;
    } else if (targetTurnId && v27TurnPaused.has(targetTurnId)) {
      sessionWaiting = true;
    } else if (v27SessionEnded) {
      turnCompleted = true;
      error = v27SessionError;
    }

    if (!error && targetTurnId && v27TurnErrors.has(targetTurnId)) {
      error = v27TurnErrors.get(targetTurnId);
    }

    if (targetTurnId) {
      const replyPartIds = v27TurnReplies.get(targetTurnId);
      if (replyPartIds && replyPartIds.length > 0) {
        for (const partId of replyPartIds) {
          const part = v27Parts.get(partId);
          if (part && part.kind === "text" && part.text) {
            messages.push({ id: part.id, text: part.text });
          }
        }
      }
      if (messages.length === 0) {
        for (const partId of v27PartOrder) {
          const part = v27Parts.get(partId);
          if (
            part &&
            part.turnId === targetTurnId &&
            part.kind === "text" &&
            part.phase === "reply" &&
            part.text
          ) {
            messages.push({ id: part.id, text: part.text });
          }
        }
      }
      if (messages.length === 0) {
        for (const partId of v27DeltaOrder) {
          const delta = v27Deltas.get(partId);
          if (
            delta &&
            delta.turnId === targetTurnId &&
            (delta.kind === undefined || delta.kind === "text")
          ) {
            deltas.push(delta.chunks.join(""));
          }
        }
      }
    }

    return {
      messages,
      text:
        messages.length > 0
          ? messages.map((m) => m.text).join("\n\n")
          : deltas.join(""),
      turnCompleted,
      sessionWaiting,
      turnId: targetTurnId,
      ...(error ? { error } : {}),
    };
  }

  // Unscoped v27 read (first turn without deliveryId or full history sync)
  const allReplyPartIds = new Set<string>();
  for (const ids of v27TurnReplies.values()) {
    for (const id of ids) allReplyPartIds.add(id);
  }
  for (const partId of v27PartOrder) {
    const part = v27Parts.get(partId);
    if (
      part &&
      part.kind === "text" &&
      part.text &&
      (part.phase === "reply" || allReplyPartIds.has(part.id))
    ) {
      messages.push({ id: part.id, text: part.text });
    }
  }
  if (messages.length === 0) {
    for (const partId of v27DeltaOrder) {
      const delta = v27Deltas.get(partId);
      if (delta && (delta.kind === undefined || delta.kind === "text")) {
        deltas.push(delta.chunks.join(""));
      }
    }
  }

  const error =
    (v27LatestTurnId ? v27TurnErrors.get(v27LatestTurnId) : undefined) ??
    v27SessionError;

  return {
    messages,
    text:
      messages.length > 0
        ? messages.map((m) => m.text).join("\n\n")
        : deltas.join(""),
    turnCompleted: v27TurnOutcomes.size > 0 || v27SessionEnded,
    sessionWaiting: v27TurnPaused.size > 0,
    turnId: v27LatestTurnId,
    ...(error ? { error } : {}),
  };
}

/**
 * Messages not persisted yet. `knownTexts` is the history sync's safety net:
 * ids changed scheme across eve versions (v26 event ids, then bare part ids,
 * now session-scoped ones), so a reply whose text is already in the thread is
 * not inserted again.
 */
export function findMissingEveMessages(
  knownIds: Set<string> | string[],
  messages: ParsedEveMessage[],
  knownTexts: Set<string> = new Set()
): ParsedEveMessage[] {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  return messages.filter((m) => !known.has(m.id) && !knownTexts.has(m.text));
}

export class EveClientError extends Error {
  status: number;
  code?: string;

  constructor(message: string, opts: { status: number; code?: string }) {
    super(message);
    this.name = "EveClientError";
    this.status = opts.status;
    this.code = opts.code;
  }
}

export type FetchImpl = typeof fetch;

interface EveCall {
  baseUrl: string;
  auth: EveAuth;
}

function authHeaders(auth: EveAuth): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: basicAuthHeader(auth.username, auth.password),
  };
}

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const data = (await res.json()) as { code?: unknown };
    return typeof data.code === "string" ? data.code : undefined;
  } catch {
    return undefined;
  }
}

function eveError(
  action: string,
  res: Response,
  code: string | undefined
): EveClientError {
  const suffix = code ? `: ${code}` : "";
  return new EveClientError(`EVE ${action} failed (HTTP ${res.status}${suffix})`, {
    status: res.status,
    code,
  });
}

export async function createEveSession(
  input: EveCall & { message: string; operationId?: string },
  fetchImpl: FetchImpl = fetch
): Promise<{ sessionId: string; deliveryId?: string }> {
  const res = await fetchImpl(`${input.baseUrl}/eve/v1/session`, {
    method: "POST",
    headers: authHeaders(input.auth),
    body: JSON.stringify({
      message: input.message,
      ...(input.operationId ? { operationId: input.operationId } : {}),
    }),
  });
  if (!res.ok) throw eveError("session create", res, await readErrorCode(res));
  const data = (await res.json()) as { sessionId?: unknown; deliveryId?: unknown };
  const sessionId =
    typeof data.sessionId === "string" && data.sessionId
      ? data.sessionId
      : res.headers.get("x-eve-session-id")?.trim() ?? "";
  if (!sessionId) {
    throw new EveClientError("EVE session create returned no sessionId", {
      status: res.status,
    });
  }
  const deliveryId =
    typeof data.deliveryId === "string" && data.deliveryId
      ? data.deliveryId
      : undefined;
  return deliveryId ? { sessionId, deliveryId } : { sessionId };
}

export async function sendEveMessage(
  input: EveCall & { sessionId: string; message: string },
  fetchImpl: FetchImpl = fetch
): Promise<{ deliveryId?: string }> {
  const res = await fetchImpl(
    `${input.baseUrl}/eve/v1/session/${input.sessionId}`,
    {
      method: "POST",
      headers: authHeaders(input.auth),
      body: JSON.stringify({ message: input.message }),
    }
  );
  if (!res.ok) throw eveError("session message", res, await readErrorCode(res));
  const data = (await res.json().catch(() => ({}))) as { deliveryId?: unknown };
  const deliveryId = typeof data.deliveryId === "string" ? data.deliveryId : undefined;
  return deliveryId ? { deliveryId } : {};
}

const MAX_LEASE_RECONNECTS = 60;

export async function readEveStreamToTerminal(
  input: EveCall & {
    sessionId: string;
    follow?: boolean;
    signal?: AbortSignal;
    deliveryId?: string;
  },
  fetchImpl: FetchImpl = fetch
): Promise<string> {
  input.signal?.throwIfAborted?.();
  const streamUrl = `${input.baseUrl}/eve/v1/session/${input.sessionId}/stream`;
  let acc = "";
  let cursor = 0;

  for (let reconnect = 0; reconnect <= MAX_LEASE_RECONNECTS; reconnect++) {
    input.signal?.throwIfAborted?.();
    const url =
      input.follow === false
        ? `${streamUrl}?follow=false`
        : cursor > 0
          ? `${streamUrl}?startIndex=${cursor}`
          : streamUrl;
    const res = await fetchImpl(url, {
      headers: {
        Authorization: basicAuthHeader(input.auth.username, input.auth.password),
      },
      signal: input.signal,
    });
    if (!res.ok) throw eveError("session stream", res, await readErrorCode(res));
    if (!res.body) {
      throw new EveClientError("EVE session stream returned an empty body", {
        status: res.status,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";
    let leaseEnded = false;
    let streamEnded = false;

    const processLine = (rawLine: string) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>;
          if (typeof rec.$eve === "string") {
            if (
              rec.$eve === "position" &&
              typeof rec.next === "number" &&
              Number.isSafeInteger(rec.next)
            ) {
              cursor = Math.max(cursor, rec.next);
            } else if (rec.$eve === "stream.lease-ended") {
              leaseEnded = true;
            } else if (rec.$eve === "stream.ended") {
              streamEnded = true;
            }
            return;
          }
        }
      } catch {
        // Non-JSON lines still pass through to acc for parser tolerance.
      }
      cursor += 1;
      acc += `${trimmed}\n`;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          lineBuf += decoder.decode(value, { stream: true });
          let nl = lineBuf.indexOf("\n");
          while (nl !== -1) {
            processLine(lineBuf.slice(0, nl));
            lineBuf = lineBuf.slice(nl + 1);
            nl = lineBuf.indexOf("\n");
          }
          if (input.follow !== false) {
            const parsed = parseEveStream(acc, { deliveryId: input.deliveryId });
            if (parsed.turnCompleted || parsed.sessionWaiting) {
              await reader.cancel().catch(() => {});
              return acc;
            }
          }
        }
        if (done) {
          lineBuf += decoder.decode();
          if (lineBuf.trim()) processLine(lineBuf);
          break;
        }
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }

    if (input.follow === false) return acc;

    const parsed = parseEveStream(acc, { deliveryId: input.deliveryId });
    if (parsed.turnCompleted || parsed.sessionWaiting) return acc;

    if (!leaseEnded || streamEnded || input.signal?.aborted) return acc;
  }

  return acc;
}
