import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend inbound: webhook signature verification + body retrieval.
 *
 * Resend signs webhooks with Svix. Its docs only show the SDK path and link
 * to Svix's manual scheme, implemented here without the dependency:
 *   signed content = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   key            = base64-decode(secret without the `whsec_` prefix)
 *   signature      = base64(HMAC-SHA256(key, signed content))
 *   header         = space-separated `v1,<signature>` entries (key rotation)
 */

const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id?: string | null;
  timestamp?: string | null;
  signature?: string | null;
}

export function verifySvixSignature(
  secret: string,
  headers: SvixHeaders,
  rawBody: string,
  now: Date = new Date()
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now.getTime() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();

  return signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const candidate = Buffer.from(value, "base64");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

export interface ReceivedEmail {
  id: string;
  from: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  message_id: string | null;
  headers?: Record<string, string> | null;
  authentication?: { spf?: string | null; dkim?: string | null; dmarc?: string | null } | null;
}

/**
 * The webhook carries metadata only; the body lives behind the API. Needs a
 * key with receiving access: RESEND_INBOUND_API_KEY when the sending key is
 * restricted to "sending access", else RESEND_API_KEY.
 */
export async function fetchReceivedEmail(emailId: string): Promise<ReceivedEmail> {
  const apiKey = process.env.RESEND_INBOUND_API_KEY?.trim() || process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("No Resend API key configured to read received emails");

  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`Resend receiving ${res.status}: ${detail}`);
  }
  return (await res.json()) as ReceivedEmail;
}
