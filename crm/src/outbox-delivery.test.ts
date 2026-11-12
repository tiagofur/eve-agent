import { describe, expect, it, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { pool, db } from "./db/client";
import { organizations, contacts, outbox, interactions, events } from "./db/schema";
import {
  createOutreachDraft,
  reviewOutreachDraft,
  deliverApprovedDraft,
  markDraftSent,
} from "./domain/outbox";

/**
 * Automated email delivery of owner-approved drafts. The provider is always
 * a stubbed fetch: no test may reach the real Resend API.
 */
const ACTOR = "test:outbox-delivery";
const OWNER = "owner:test";
const ORG_NAME = "TEST-Outbox Delivery";

let orgId: string;
let emailContactId: string;
let noEmailContactId: string;

const fetchMock = vi.fn();

function resendOk(id = "re_test_123") {
  return new Response(JSON.stringify({ id }), { status: 200 });
}

async function pendingDraft(over: Partial<Parameters<typeof createOutreachDraft>[0]> = {}) {
  const created = await createOutreachDraft({
    organizationId: orgId,
    contactId: emailContactId,
    channel: "email",
    subject: "Seguimiento de tu propuesta",
    body: "Hola, te escribo por la propuesta.",
    actor: ACTOR,
    ...over,
  });
  if (!created.success) throw new Error(`setup failed: ${created.message}`);
  return created.draft;
}

async function statusOf(draftId: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, draftId)).limit(1);
  return row!.status;
}

beforeAll(async () => {
  const [org] = await db.insert(organizations).values({ name: ORG_NAME }).returning();
  orgId = org!.id;
  const [withEmail] = await db
    .insert(contacts)
    .values({ organizationId: orgId, name: "TEST Con Email", email: "test-delivery@example.invalid" })
    .returning();
  emailContactId = withEmail!.id;
  const [noEmail] = await db
    .insert(contacts)
    .values({ organizationId: orgId, name: "TEST Sin Email", phone: "+52 322 000 2222" })
    .returning();
  noEmailContactId = noEmail!.id;
});

beforeEach(async () => {
  await db.delete(interactions).where(eq(interactions.organizationId, orgId));
  await db.delete(outbox).where(eq(outbox.organizationId, orgId));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("OUTBOX_EMAIL_FROM", "Creapolis <hola@example.invalid>");
  vi.stubEnv("OUTBOX_EMAIL_REPLY_TO", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.delete(interactions).where(eq(interactions.organizationId, orgId));
  await db.delete(outbox).where(eq(outbox.organizationId, orgId));
  await db.delete(contacts).where(eq(contacts.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pool.end();
});

describe("outbox automated email delivery", () => {
  it("sends on approval, marks the draft sent and logs the interaction", async () => {
    fetchMock.mockResolvedValueOnce(resendOk());
    const draft = await pendingDraft();

    const result = await reviewOutreachDraft({ draftId: draft.id, decision: "approved", actor: OWNER });

    expect(result.success).toBe(true);
    if (!result.success || !("delivery" in result)) throw new Error("expected delivery outcome");
    expect(result.delivery).toEqual({ status: "sent", providerId: "re_test_123" });
    expect(result.draft?.status).toBe("sent");
    expect(result.draft?.sentAt).toBeInstanceOf(Date);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(init.headers["Idempotency-Key"]).toBe(`outbox-${draft.id}`);
    expect(JSON.parse(init.body)).toEqual({
      from: "Creapolis <hola@example.invalid>",
      to: ["test-delivery@example.invalid"],
      subject: "Seguimiento de tu propuesta",
      text: "Hola, te escribo por la propuesta.",
    });

    const logged = await db
      .select()
      .from(interactions)
      .where(and(eq(interactions.organizationId, orgId), eq(interactions.direction, "outbound")));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.content).toBe("Hola, te escribo por la propuesta.");
  });

  it("adds reply_to when configured", async () => {
    vi.stubEnv("OUTBOX_EMAIL_REPLY_TO", "respuestas@example.invalid");
    fetchMock.mockResolvedValueOnce(resendOk());
    const draft = await pendingDraft();

    await reviewOutreachDraft({ draftId: draft.id, decision: "approved", actor: OWNER });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).reply_to).toBe("respuestas@example.invalid");
  });

  it("parks the draft as failed with the provider error, then a retry sends it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Domain is not verified" }), { status: 403 })
    );
    const draft = await pendingDraft();

    const result = await reviewOutreachDraft({ draftId: draft.id, decision: "approved", actor: OWNER });

    if (!result.success || !("delivery" in result)) throw new Error("expected delivery outcome");
    expect(result.delivery).toEqual({ status: "failed", error: "Resend 403: Domain is not verified" });
    expect(await statusOf(draft.id)).toBe("failed");
    expect(await db.select().from(interactions).where(eq(interactions.organizationId, orgId))).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(events)
      .where(and(eq(events.entityId, draft.id), eq(events.action, "draft_send_failed")));
    expect(audit).toBeDefined();

    fetchMock.mockResolvedValueOnce(resendOk("re_retry"));
    const retry = await deliverApprovedDraft({ draftId: draft.id, actor: OWNER });
    expect(retry).toEqual({ status: "sent", providerId: "re_retry" });
    expect(await statusOf(draft.id)).toBe("sent");
  });

  it("treats a network error as a failed delivery, not a crash", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    const draft = await pendingDraft();

    const result = await reviewOutreachDraft({ draftId: draft.id, decision: "approved", actor: OWNER });

    if (!result.success || !("delivery" in result)) throw new Error("expected delivery outcome");
    expect(result.delivery).toEqual({ status: "failed", error: "fetch failed" });
    expect(await statusOf(draft.id)).toBe("failed");
  });

  it("lets the owner mark a failed draft as sent by hand", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed"));
    const draft = await pendingDraft();
    await reviewOutreachDraft({ draftId: draft.id, decision: "approved", actor: OWNER });

    const marked = await markDraftSent({ draftId: draft.id, actor: OWNER });

    expect(marked.success).toBe(true);
    expect(await statusOf(draft.id)).toBe("sent");
  });

  it("stays manual and sends nothing when email delivery is not configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const draft = await pendingDraft();

    const result = await reviewOutreachDraft({ draftId: draft.id, decision: "approved", actor: OWNER });

    if (!result.success || !("delivery" in result)) throw new Error("expected delivery outcome");
    expect(result.delivery).toEqual({ status: "manual", reason: "email_not_configured" });
    expect(result.draft?.status).toBe("approved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-email channel", { channel: "linkedin" as const }, "channel_not_automated"],
    ["a contact without email", { contactId: "NO_EMAIL" }, "contact_email_missing"],
    ["a draft without subject", { subject: undefined }, "subject_missing"],
  ])("stays manual for %s", async (_label, over, reason) => {
    const patch = "contactId" in over ? { contactId: noEmailContactId } : over;
    const draft = await pendingDraft(patch);

    const result = await reviewOutreachDraft({ draftId: draft.id, decision: "approved", actor: OWNER });

    if (!result.success || !("delivery" in result)) throw new Error("expected delivery outcome");
    expect(result.delivery).toEqual({ status: "manual", reason });
    expect(await statusOf(draft.id)).toBe("approved");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends a rejected or still-pending draft", async () => {
    const draft = await pendingDraft();

    expect(await deliverApprovedDraft({ draftId: draft.id, actor: OWNER })).toEqual({
      status: "skipped",
      reason: "invalid_status",
    });

    await reviewOutreachDraft({ draftId: draft.id, decision: "rejected", rejectedReason: "no", actor: OWNER });
    expect(await deliverApprovedDraft({ draftId: draft.id, actor: OWNER })).toEqual({
      status: "skipped",
      reason: "invalid_status",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send twice when the draft is already sent", async () => {
    fetchMock.mockResolvedValueOnce(resendOk());
    const draft = await pendingDraft();
    await reviewOutreachDraft({ draftId: draft.id, decision: "approved", actor: OWNER });

    const again = await deliverApprovedDraft({ draftId: draft.id, actor: OWNER });

    expect(again).toEqual({ status: "skipped", reason: "invalid_status" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
