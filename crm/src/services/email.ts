/**
 * Outbound email delivery for owner-approved outbox drafts (Resend HTTP API).
 *
 * Fails closed: without RESEND_API_KEY + OUTBOX_EMAIL_FROM nothing is sent and
 * approved drafts stay in the manual copy-paste queue, exactly as before.
 * Env is read per call so tests and a restarted daemon pick up changes.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 15_000;

export interface EmailConfig {
  apiKey: string;
  from: string;
  replyTo?: string;
}

/** Returns the delivery config, or null when email delivery is not set up. */
export function getEmailConfig(): EmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.OUTBOX_EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  const replyTo = process.env.OUTBOX_EMAIL_REPLY_TO?.trim() || undefined;
  return { apiKey, from, replyTo };
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /**
   * Stable per message: a retry after a timeout must not deliver twice when
   * the first request actually reached the provider.
   */
  idempotencyKey: string;
}

export type SendEmailResult =
  | { ok: true; providerId: string | null }
  | { ok: false; error: string };

export async function sendEmail(config: EmailConfig, input: SendEmailInput): Promise<SendEmailResult> {
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: config.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(config.replyTo ? { reply_to: config.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    const raw = await res.text();
    let payload: { id?: string; message?: string; name?: string } = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      // Non-JSON body (proxy error page): keep the raw text for the audit log.
    }

    if (!res.ok) {
      const detail = payload.message || raw.slice(0, 300) || res.statusText;
      return { ok: false, error: `Resend ${res.status}: ${detail}` };
    }
    return { ok: true, providerId: payload.id ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
