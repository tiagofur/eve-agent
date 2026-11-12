import { Hono } from "hono";
import { ingestInboundEmail } from "../../domain/inbound-email";
import { fetchReceivedEmail, verifySvixSignature } from "../../services/resend-inbound";

/**
 * Public webhook surface (no API key): authenticity comes from the provider
 * signature. Fails closed — without RESEND_WEBHOOK_SECRET it answers 503.
 */
export const inboundRouter = new Hono();

inboundRouter.post("/resend", async (c) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return c.json({ error: "Inbound email is not configured" }, 503);

  // Signature covers the exact bytes: read the raw body before any parsing.
  const rawBody = await c.req.text();
  const valid = verifySvixSignature(
    secret,
    {
      id: c.req.header("svix-id"),
      timestamp: c.req.header("svix-timestamp"),
      signature: c.req.header("svix-signature"),
    },
    rawBody
  );
  if (!valid) return c.json({ error: "Invalid webhook signature" }, 401);

  let event: { type?: string; data?: { email_id?: string; from?: string; subject?: string; message_id?: string } };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Malformed JSON" }, 400);
  }

  // The same endpoint may be subscribed to other events: acknowledge, ignore.
  if (event.type !== "email.received") return c.json({ status: "ignored", reason: "event_type" });

  const emailId = event.data?.email_id;
  if (!emailId) return c.json({ error: "Missing data.email_id" }, 400);

  let email;
  try {
    email = await fetchReceivedEmail(emailId);
  } catch (err) {
    // 502 makes the provider retry later instead of dropping the reply.
    console.error("[Inbound] could not fetch received email:", (err as Error).message);
    return c.json({ error: "Could not retrieve the received email" }, 502);
  }

  const result = await ingestInboundEmail({
    // `headers.from` keeps the display name; either form resolves the address.
    from: email.from || event.data?.from || "",
    subject: email.subject ?? event.data?.subject ?? null,
    text: email.text,
    html: email.html,
    messageId: email.message_id ?? event.data?.message_id ?? null,
    providerId: emailId,
    senderVerified: email.authentication?.dmarc !== "fail",
  });

  return c.json(result);
});
