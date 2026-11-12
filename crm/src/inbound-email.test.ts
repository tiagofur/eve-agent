import { describe, expect, it, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, organizations, contacts, leads, outbox, interactions } from "./db/schema";
import {
  extractAddress,
  htmlToText,
  ingestInboundEmail,
  stripQuotedReply,
  getUnansweredReplies,
} from "./domain/inbound-email";
import { verifySvixSignature } from "./services/resend-inbound";

/** Inbound email replies. Resend is always a stubbed fetch. */
const ORG_NAME = "TEST-Inbound Email";
const EMAIL = "test-inbound-reply@example.invalid";
const OPS_KEY = "cp_ops_inboundtestkey1234567890abcd";
// Svix-style secret: "whsec_" + base64 key.
const SECRET = `whsec_${Buffer.from("inbound-test-signing-key").toString("base64")}`;

let orgId: string;
let contactId: string;
let leadId: string;

function sign(body: string, id = "msg_test", ts = Math.floor(Date.now() / 1000)) {
  const key = Buffer.from(SECRET.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` };
}

async function cleanup() {
  await db.delete(interactions).where(eq(interactions.contactId, contactId));
  await db.delete(outbox).where(eq(outbox.contactId, contactId));
  await db.update(leads).set({ nextFollowUpAt: null, followUpNote: null }).where(eq(leads.id, leadId));
  await db.update(contacts).set({ nextFollowUpAt: null, followUpNote: null }).where(eq(contacts.id, contactId));
}

beforeAll(async () => {
  await db.insert(apiKeys).values({ name: "Inbound Ops", scope: "ops", keyHash: hashApiKey(OPS_KEY) });
  const [org] = await db.insert(organizations).values({ name: ORG_NAME }).returning();
  orgId = org!.id;
  const [contact] = await db
    .insert(contacts)
    .values({ organizationId: orgId, name: "TEST Responde", email: EMAIL })
    .returning();
  contactId = contact!.id;
  const [lead] = await db
    .insert(leads)
    .values({ organizationId: orgId, contactId, source: "test", stage: "contacted" })
    .returning();
  leadId = lead!.id;
});

beforeEach(cleanup);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await cleanup();
  await db.delete(leads).where(eq(leads.id, leadId));
  await db.delete(contacts).where(eq(contacts.id, contactId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(OPS_KEY)));
  await pool.end();
});

describe("reply parsing helpers", () => {
  it("extracts the bare address from either form", () => {
    expect(extractAddress("Ana Pérez <Ana@Example.com>")).toBe("ana@example.com");
    expect(extractAddress(" ana@example.com ")).toBe("ana@example.com");
    expect(extractAddress("not an address")).toBeNull();
  });

  it("drops the quoted thread below a reply", () => {
    const text = "Hola, sí me interesa.\n¿Hablamos el martes?\n\nEl mié, 11 nov 2026 a las 10:00, Creapolis <hola@creapolis.dev> escribió:\n> Hola Ana\n> te escribo por...";
    expect(stripQuotedReply(text)).toBe("Hola, sí me interesa.\n¿Hablamos el martes?");
  });

  it("handles the two-line Gmail attribution and English clients", () => {
    expect(stripQuotedReply("Sounds good.\n\nOn Wed, Nov 11, 2026 at 10:00 AM Creapolis\n<hola@creapolis.dev> wrote:\n> hi")).toBe("Sounds good.");
    expect(stripQuotedReply("Ok\n\n-----Original Message-----\nFrom: x@y.com")).toBe("Ok");
  });

  it("keeps the whole text when stripping would leave nothing", () => {
    expect(stripQuotedReply("> solo cita\n> más cita")).toBe("> solo cita\n> más cita");
  });

  it("converts html-only bodies to readable text", () => {
    expect(htmlToText("<div>Hola <b>equipo</b></div><p>Sí&nbsp;&amp; gracias</p><style>x{}</style>")).toBe(
      "Hola equipo\nSí & gracias"
    );
  });
});

describe("verifySvixSignature", () => {
  const body = '{"type":"email.received"}';

  it("accepts a valid signature, including among rotated ones", () => {
    const h = sign(body);
    const headers = { id: h["svix-id"], timestamp: h["svix-timestamp"], signature: `v1,AAAA ${h["svix-signature"]}` };
    expect(verifySvixSignature(SECRET, headers, body)).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a stale timestamp and missing headers", () => {
    const h = sign(body);
    const headers = { id: h["svix-id"], timestamp: h["svix-timestamp"], signature: h["svix-signature"] };
    expect(verifySvixSignature(SECRET, headers, body + " ")).toBe(false);
    expect(verifySvixSignature(`whsec_${Buffer.from("other").toString("base64")}`, headers, body)).toBe(false);
    expect(verifySvixSignature(SECRET, headers, body, new Date(Date.now() + 10 * 60_000))).toBe(false);
    expect(verifySvixSignature(SECRET, { ...headers, signature: null }, body)).toBe(false);
  });
});

describe("ingestInboundEmail", () => {
  it("logs the reply on the lead thread and surfaces the follow-up today", async () => {
    const result = await ingestInboundEmail({
      from: `TEST Responde <${EMAIL.toUpperCase()}>`,
      subject: "Re: Propuesta",
      text: "Sí, me interesa.\n\nEl lun escribió:\n> hola",
      messageId: "<reply-1@example.invalid>",
    });

    expect(result.status).toBe("logged");
    if (result.status !== "logged") return;
    expect(result.leadId).toBe(leadId);
    expect(result.followUpMoved).toBe(true);

    const [row] = await db.select().from(interactions).where(eq(interactions.id, result.interactionId));
    expect(row).toMatchObject({ direction: "inbound", channel: "email", content: "Sí, me interesa.", leadId, contactId });
    expect(row!.organizationId).toBe(orgId);

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.nextFollowUpAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(lead!.followUpNote).toContain("Respondió por email");
  });

  it("is idempotent on Message-ID (webhook retries)", async () => {
    const input = { from: EMAIL, text: "Hola", messageId: "<dup@example.invalid>" };
    const first = await ingestInboundEmail(input);
    const second = await ingestInboundEmail(input);

    expect(first.status).toBe("logged");
    expect(second.status).toBe("duplicate");
    expect(await db.select().from(interactions).where(eq(interactions.contactId, contactId))).toHaveLength(1);
  });

  it("threads onto the ticket/lead of the last sent draft", async () => {
    await db.insert(outbox).values({
      organizationId: orgId,
      contactId,
      channel: "email",
      subject: "Aviso",
      body: "x",
      status: "sent",
      sentAt: new Date(),
      createdBy: "test",
    });

    const result = await ingestInboundEmail({ from: EMAIL, text: "Gracias", messageId: "<org-thread@example.invalid>" });

    expect(result.status).toBe("logged");
    if (result.status !== "logged") return;
    // That draft targeted the organization, not a lead: the contact gets the follow-up.
    expect(result.leadId).toBeNull();
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(contact!.followUpNote).toContain("Respondió por email");
  });

  it("records a DMARC-failed sender but never moves follow-ups", async () => {
    const result = await ingestInboundEmail({
      from: EMAIL,
      text: "Págame a esta cuenta",
      messageId: "<spoof@example.invalid>",
      senderVerified: false,
    });

    expect(result).toMatchObject({ status: "logged", followUpMoved: false });
    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId));
    expect(lead!.nextFollowUpAt).toBeNull();
  });

  it("does not create anything for unknown senders or empty bodies", async () => {
    expect(await ingestInboundEmail({ from: "nadie-test@example.invalid", text: "Hola" })).toEqual({
      status: "unmatched",
      from: "nadie-test@example.invalid",
    });
    expect(await ingestInboundEmail({ from: EMAIL, text: "   " })).toEqual({ status: "ignored", reason: "empty_body" });
    expect(await ingestInboundEmail({ from: "garbage", text: "x" })).toEqual({ status: "ignored", reason: "invalid_sender" });
    expect(await db.select().from(interactions).where(eq(interactions.contactId, contactId))).toHaveLength(0);
  });
});

describe("unanswered replies in the follow-up queue", () => {
  it("flags a contact only while their inbound message is the latest", async () => {
    await ingestInboundEmail({ from: EMAIL, text: "¿Cuánto cuesta?", messageId: "<q@example.invalid>" });
    expect((await getUnansweredReplies([contactId])).get(contactId)?.excerpt).toBe("¿Cuánto cuesta?");

    const res = await app.request("/api/reports/followups", { headers: { Authorization: `Bearer ${OPS_KEY}` } });
    const queue = (await res.json()) as { overdue: Array<{ kind: string; id: string; unansweredReply: { excerpt: string } | null }> };
    const item = queue.overdue.find((i) => i.kind === "lead" && i.id === leadId);
    expect(item?.unansweredReply?.excerpt).toBe("¿Cuánto cuesta?");

    await db.insert(interactions).values({
      contactId,
      leadId,
      channel: "email",
      direction: "outbound",
      content: "Te respondo",
      createdAt: new Date(Date.now() + 1000),
    });
    expect((await getUnansweredReplies([contactId])).has(contactId)).toBe(false);
  });
});

describe("POST /api/inbound/resend", () => {
  const event = JSON.stringify({
    type: "email.received",
    data: { email_id: "re_in_1", from: EMAIL, subject: "Re: Hola", message_id: "<hook@example.invalid>" },
  });

  const post = (body: string, headers: Record<string, string>) =>
    app.request("/api/inbound/resend", { method: "POST", body, headers });

  it("answers 503 when the webhook secret is not configured", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect((await post(event, sign(event))).status).toBe(503);
  });

  it("rejects an unsigned or badly signed request without calling Resend", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect((await post(event, {})).status).toBe(401);
    expect((await post(event, { ...sign(event), "svix-signature": "v1,AAAA" })).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the body from Resend and logs the reply", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("RESEND_INBOUND_API_KEY", "");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "re_in_1",
          from: EMAIL,
          subject: "Re: Hola",
          text: null,
          html: "<p>Me interesa, hablemos.</p>",
          message_id: "<hook@example.invalid>",
          authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await post(event, sign(event));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "logged", leadId, followUpMoved: true });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.resend.com/emails/receiving/re_in_1");
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer re_test_key");
    const rows = await db.select().from(interactions).where(eq(interactions.contactId, contactId));
    expect(rows.map((r) => r.content)).toEqual(["Me interesa, hablemos."]);
  });

  it("answers 502 so the provider retries when the body cannot be fetched", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("restricted key", { status: 403 })));

    expect((await post(event, sign(event))).status).toBe(502);
    expect(await db.select().from(interactions).where(eq(interactions.contactId, contactId))).toHaveLength(0);
  });

  it("acknowledges and ignores other event types", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", SECRET);
    const other = JSON.stringify({ type: "email.delivered", data: {} });
    const res = await post(other, sign(other));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ignored", reason: "event_type" });
  });
});
