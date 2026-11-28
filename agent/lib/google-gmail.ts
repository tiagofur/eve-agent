/**
 * Gmail integration for the Creapolis.Dev eve agent (`creapolis.mx@gmail.com`).
 *
 * Pure `fetch` against the Gmail REST API v1 — no googleapis dependency.
 * Reuses the same Google OAuth Desktop-app credentials as `google-calendar.ts`:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.
 *
 * Scopes required in `scripts/google-auth.mjs`:
 *   - https://www.googleapis.com/auth/gmail.readonly
 *   - https://www.googleapis.com/auth/gmail.compose
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 12_000;

export interface GoogleGmailEnv {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function readGmailEnv(): GoogleGmailEnv | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

export function gmailSetupHint(): string {
  return (
    "Gmail no configurado. El dueño debe: 1) habilitar Gmail API y Google Calendar API " +
    "en Google Cloud con un OAuth client de tipo Desktop, 2) correr " +
    "`GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-auth.mjs` " +
    "iniciando sesión con creapolis.mx@gmail.com, y 3) guardar GOOGLE_CLIENT_ID, " +
    "GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN en el .env del servicio. " +
    "Ver docs/OPERATIONS_RUNBOOK.md."
  );
}

async function refreshGmailAccessToken(env: GoogleGmailEnv): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: env.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (response.status !== 200 || typeof data?.access_token !== "string") {
    const code = typeof data?.error === "string" ? data.error : `HTTP ${response.status}`;
    const needsConsent =
      code === "invalid_grant"
        ? " El refresh token fue revocado o expiró: repite el consentimiento con `node scripts/google-auth.mjs`."
        : "";
    throw new Error(`No se pudo renovar el acceso a Google (${code}).${needsConsent}`);
  }
  return data.access_token;
}

function getHeader(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  return headers.find((h) => h.name?.toLowerCase() === lower)?.value ?? "";
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function encodeBase64Url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export interface GmailPayloadPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPayloadPart[];
}

export function extractBodyFromPayload(payload: GmailPayloadPart | undefined): string {
  if (!payload) return "";

  const plainParts: string[] = [];
  const htmlParts: string[] = [];

  const walk = (part: GmailPayloadPart) => {
    const mime = (part.mimeType || "").toLowerCase();
    if (part.body?.data) {
      const decoded = decodeBase64Url(part.body.data);
      if (mime === "text/plain") {
        plainParts.push(decoded);
      } else if (mime === "text/html") {
        htmlParts.push(decoded);
      }
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) walk(child);
    }
  };

  walk(payload);

  const raw =
    plainParts.length > 0
      ? plainParts.join("\n\n").trim()
      : htmlParts.length > 0
        ? stripHtml(htmlParts.join("\n\n"))
        : "";

  if (raw.length <= MAX_BODY_CHARS) return raw;
  return `${raw.slice(0, MAX_BODY_CHARS)}\n\n[...contenido truncado a ${MAX_BODY_CHARS} caracteres]`;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  isUnread: boolean;
  labelIds: string[];
}

export async function listGmailMessages(
  options: { query?: string; maxResults?: number } = {},
  env: GoogleGmailEnv | null = readGmailEnv()
): Promise<{ ok: boolean; message: string; messages?: GmailMessageSummary[] }> {
  if (!env) {
    return { ok: false, message: gmailSetupHint() };
  }

  let accessToken: string;
  try {
    accessToken = await refreshGmailAccessToken(env);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Fallo de autenticación con Google.",
    };
  }

  const maxResults = Math.min(Math.max(options.maxResults ?? 10, 1), 25);
  const q = options.query?.trim() || "in:inbox";

  const listUrl =
    `${GMAIL_API_BASE}/messages?` +
    new URLSearchParams({ q, maxResults: String(maxResults) }).toString();

  try {
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (listRes.status === 403) {
      return {
        ok: false,
        message:
          "Gmail API respondió HTTP 403 (permisos insuficientes). Verifica que la Gmail API esté habilitada en Google Cloud y vuelve a correr `node scripts/google-auth.mjs` para aprobar los scopes de Gmail.",
      };
    }
    if (!listRes.ok) {
      throw new Error(`Gmail API respondió HTTP ${listRes.status}`);
    }

    const listData = (await listRes.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
    };
    const refs = listData.messages ?? [];
    if (refs.length === 0) {
      return {
        ok: true,
        message: `No se encontraron correos para la consulta "${q}".`,
        messages: [],
      };
    }

    const details = await Promise.all(
      refs.map(async (ref) => {
        const msgUrl =
          `${GMAIL_API_BASE}/messages/${encodeURIComponent(ref.id)}?` +
          "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
        const res = await fetch(msgUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) return null;
        const msg = (await res.json()) as {
          id: string;
          threadId: string;
          snippet?: string;
          labelIds?: string[];
          payload?: { headers?: Array<{ name?: string; value?: string }> };
        };
        const headers = msg.payload?.headers;
        const labels = msg.labelIds ?? [];
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: getHeader(headers, "From"),
          to: getHeader(headers, "To"),
          subject: getHeader(headers, "Subject") || "(Sin asunto)",
          date: getHeader(headers, "Date"),
          snippet: msg.snippet ?? "",
          isUnread: labels.includes("UNREAD"),
          labelIds: labels,
        } satisfies GmailMessageSummary;
      })
    );

    const messages = details.filter((m): m is GmailMessageSummary => m !== null);
    return {
      ok: true,
      message: `Se encontraron ${messages.length} correo(s) para "${q}".`,
      messages,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Error al consultar Gmail.",
    };
  }
}

export interface GmailFullMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  messageIdHeader: string;
  snippet: string;
  body: string;
  isUnread: boolean;
}

function toFullMessage(msg: {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPayloadPart & { headers?: Array<{ name?: string; value?: string }> };
}): GmailFullMessage {
  const headers = msg.payload?.headers;
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject") || "(Sin asunto)",
    date: getHeader(headers, "Date"),
    messageIdHeader: getHeader(headers, "Message-ID"),
    snippet: msg.snippet ?? "",
    body: extractBodyFromPayload(msg.payload),
    isUnread: (msg.labelIds ?? []).includes("UNREAD"),
  };
}

export async function readGmailMessageOrThread(
  input: { messageId?: string; threadId?: string },
  env: GoogleGmailEnv | null = readGmailEnv()
): Promise<{ ok: boolean; message: string; messages?: GmailFullMessage[] }> {
  if (!env) {
    return { ok: false, message: gmailSetupHint() };
  }
  if (!input.messageId && !input.threadId) {
    return { ok: false, message: "Debes proporcionar messageId o threadId." };
  }

  let accessToken: string;
  try {
    accessToken = await refreshGmailAccessToken(env);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Fallo de autenticación con Google.",
    };
  }

  try {
    if (input.threadId) {
      const url = `${GMAIL_API_BASE}/threads/${encodeURIComponent(input.threadId)}?format=full`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Gmail API respondió HTTP ${res.status}`);
      const data = (await res.json()) as { messages?: any[] };
      const messages = (data.messages ?? []).map(toFullMessage);
      return {
        ok: true,
        message: `Hilo ${input.threadId} leído (${messages.length} mensaje(s)).`,
        messages,
      };
    }

    const url = `${GMAIL_API_BASE}/messages/${encodeURIComponent(input.messageId!)}?format=full`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Gmail API respondió HTTP ${res.status}`);
    const data = (await res.json()) as any;
    return {
      ok: true,
      message: `Mensaje ${input.messageId} leído.`,
      messages: [toFullMessage(data)],
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Error al leer el correo en Gmail.",
    };
  }
}

function encodeMimeHeader(value: string): string {
  // Use RFC 2047 UTF-8 Base64 encoding when non-ASCII characters are present.
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildRawMimeMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
}): string {
  const lines = [
    `To: ${input.to.trim()}`,
    ...(input.cc?.trim() ? [`Cc: ${input.cc.trim()}`] : []),
    `Subject: ${encodeMimeHeader(input.subject.trim())}`,
    ...(input.inReplyTo?.trim()
      ? [
          `In-Reply-To: ${input.inReplyTo.trim()}`,
          `References: ${input.inReplyTo.trim()}`,
        ]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body,
  ];
  return encodeBase64Url(lines.join("\r\n"));
}

export async function createGmailDraft(
  input: {
    to: string;
    subject: string;
    body: string;
    cc?: string;
    threadId?: string;
    inReplyTo?: string;
  },
  env: GoogleGmailEnv | null = readGmailEnv()
): Promise<{
  ok: boolean;
  message: string;
  draftId?: string;
  messageId?: string;
  threadId?: string;
}> {
  if (!env) {
    return { ok: false, message: gmailSetupHint() };
  }

  let accessToken: string;
  try {
    accessToken = await refreshGmailAccessToken(env);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Fallo de autenticación con Google.",
    };
  }

  const raw = buildRawMimeMessage({
    to: input.to,
    subject: input.subject,
    body: input.body,
    cc: input.cc,
    inReplyTo: input.inReplyTo,
  });

  try {
    const res = await fetch(`${GMAIL_API_BASE}/drafts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        message: {
          raw,
          ...(input.threadId?.trim() ? { threadId: input.threadId.trim() } : {}),
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 403) {
      return {
        ok: false,
        message:
          "Gmail API respondió HTTP 403 al crear el borrador. Revisa que el scope `gmail.compose` esté aprobado ejecutando `node scripts/google-auth.mjs`.",
      };
    }

    const data = (await res.json().catch(() => null)) as {
      id?: string;
      message?: { id?: string; threadId?: string };
    } | null;

    if (!res.ok || !data?.id) {
      throw new Error(`Gmail API respondió HTTP ${res.status} al crear el borrador.`);
    }

    return {
      ok: true,
      message: `Borrador guardado en Gmail (creapolis.mx@gmail.com) para ${input.to} con asunto "${input.subject}". No se envió automáticamente.`,
      draftId: data.id,
      messageId: data.message?.id,
      threadId: data.message?.threadId,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "No se pudo crear el borrador en Gmail.",
    };
  }
}
