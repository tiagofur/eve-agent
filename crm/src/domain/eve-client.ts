/**
 * Thin-proxy client for delegating the macOS chat to the EVE brain.
 *
 * The CRM route stays dumb: it resolves/creates the thread, forwards the new
 * user message to an EVE session, awaits the turn to a terminal event, and
 * persists the reply. Transport is injectable so tests run without network;
 * production passes the global fetch.
 *
 * Event shapes mirror the real /eve/v1 NDJSON protocol (verified in the
 * single-brain spike): session.started, turn.started, message.received (user
 * echo, ignored), step.*, message.appended (deltas), message.completed (full
 * assistant text), turn.completed, session.waiting (terminal).
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

export interface ParsedEveStream {
  messages: ParsedEveMessage[];
  /** Full assistant text: completed messages, or concatenated deltas. */
  text: string;
  turnCompleted: boolean;
  sessionWaiting: boolean;
  turnId?: string;
}

/**
 * Scoping options for replayed streams.
 *
 * The session stream is durable: opening it without a cursor replays every
 * recorded event, so a follow-up read sees the previous turn's events (and
 * its turn.completed/session.waiting) before the new turn's. Every event
 * carries `meta.deliveryIds` naming the accepted messages that own its turn,
 * and the follow-up POST response returns its `deliveryId`. Passing it here
 * keeps only the events of the turn that message owns.
 */
export interface ParseEveStreamOptions {
  deliveryId?: string;
}

interface RawEnvelope {
  type?: unknown;
  data?: unknown;
  meta?: unknown;
}

function eventBelongsToDelivery(evt: RawEnvelope, deliveryId?: string): boolean {
  if (!deliveryId) return true;
  const meta =
    evt.meta && typeof evt.meta === "object" ? (evt.meta as Record<string, unknown>) : {};
  const ids = Array.isArray(meta.deliveryIds) ? meta.deliveryIds : [];
  return ids.includes(deliveryId);
}

export function parseEveStream(
  ndjson: string,
  options?: ParseEveStreamOptions
): ParsedEveStream {
  const messages: ParsedEveMessage[] = [];
  const deltas: string[] = [];
  let turnCompleted = false;
  let sessionWaiting = false;
  let turnId: string | undefined;
  let counter = 0;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: RawEnvelope;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object") continue;
      evt = parsed as RawEnvelope;
    } catch {
      continue;
    }

    if (!eventBelongsToDelivery(evt, options?.deliveryId)) continue;

    const type = typeof evt.type === "string" ? evt.type : "";
    const data =
      evt.data && typeof evt.data === "object"
        ? (evt.data as Record<string, unknown>)
        : {};
    const meta =
      evt.meta && typeof evt.meta === "object"
        ? (evt.meta as Record<string, unknown>)
        : {};
    const metaId = typeof meta.id === "string" ? meta.id : `evt-${counter++}`;
    const eventTurnId = typeof data.turnId === "string" ? data.turnId : undefined;
    if (eventTurnId) turnId = eventTurnId;

    switch (type) {
      case "message.completed": {
        const text = typeof data.message === "string" ? data.message : "";
        if (text) messages.push({ id: metaId, text });
        break;
      }
      case "message.appended": {
        const delta = typeof data.messageDelta === "string" ? data.messageDelta : "";
        if (delta) deltas.push(delta);
        break;
      }
      case "turn.completed":
        turnCompleted = true;
        break;
      case "session.waiting":
        sessionWaiting = true;
        break;
      default:
        // session.started, turn.started, message.received (user echo),
        // step.* — not assistant content, ignored.
        break;
    }
  }

  return {
    messages,
    // Multi-message turns (status preamble + final answer) need a paragraph
    // break between messages; the streaming-deltas fallback stays unjoined.
    text: messages.length > 0 ? messages.map((m) => m.text).join("\n\n") : deltas.join(""),
    turnCompleted,
    sessionWaiting,
    turnId,
  };
}

export function findMissingEveMessages(
  knownIds: Set<string> | string[],
  messages: ParsedEveMessage[]
): ParsedEveMessage[] {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  return messages.filter((m) => !known.has(m.id));
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
): Promise<{ sessionId: string }> {
  const res = await fetchImpl(`${input.baseUrl}/eve/v1/session`, {
    method: "POST",
    headers: authHeaders(input.auth),
    body: JSON.stringify({
      message: input.message,
      ...(input.operationId ? { operationId: input.operationId } : {}),
    }),
  });
  if (!res.ok) throw eveError("session create", res, await readErrorCode(res));
  const data = (await res.json()) as { sessionId?: unknown };
  if (typeof data.sessionId !== "string" || !data.sessionId) {
    throw new EveClientError("EVE session create returned no sessionId", {
      status: res.status,
    });
  }
  return { sessionId: data.sessionId };
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
  const url =
    input.follow === false ? `${streamUrl}?follow=false` : streamUrl;
  const res = await fetchImpl(url, {
    headers: { Authorization: basicAuthHeader(input.auth.username, input.auth.password) },
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
  let acc = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        acc += decoder.decode(value, { stream: true });
        const parsed = parseEveStream(acc, { deliveryId: input.deliveryId });
        if (parsed.turnCompleted || parsed.sessionWaiting) {
          await reader.cancel().catch(() => {});
          return acc;
        }
      }
      if (done) return acc;
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}
