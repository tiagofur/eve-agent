import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, contracts, leads, organizations } from "./db/schema";
import { eq } from "drizzle-orm";

/**
 * Contracts API with strict machine (S1): draft → in_review → sent →
 * signed (owner only); void from any non-terminal state with a stored
 * reason; bad jumps rejected. Legal drafts persist with reviewer flags.
 */
describe("contracts lifecycle", () => {
  const opsKey = "cp_ops_contractkey1234567890abcdef12";
  const ownerKey = "cp_owner_contractkey1234567890abcdef";
  const ops = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  const owner = { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` };
  let orgId = "";
  let leadId = "";
  const createdIds: string[] = [];

  beforeAll(async () => {
    await db.insert(apiKeys).values([
      { name: "Contract Ops", scope: "ops", keyHash: hashApiKey(opsKey) },
      { name: "Contract Owner", scope: "owner", keyHash: hashApiKey(ownerKey) },
    ]);
    const [org] = await db.insert(organizations).values({ name: "TEST-Contracts" }).returning();
    orgId = org!.id;
    const [lead] = await db
      .insert(leads)
      .values({ organizationId: orgId, stage: "proposal", source: "test", summary: "Lead con contrato" })
      .returning();
    leadId = lead!.id;
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await db.delete(contracts).where(eq(contracts.id, id));
    }
    await db.delete(leads).where(eq(leads.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(ownerKey)));
    await pool.end();
  });

  const draftContract = async (title: string) => {
    const res = await app.request("/api/contracts", {
      method: "POST",
      headers: ops,
      body: JSON.stringify({
        leadId,
        title,
        body: "Objeto, alcance, pagos, IP, confidencialidad, terminación.",
        reviewerNote: "Revisar: razón social del cliente y jurisdicción.",
        createdBy: "legal:test",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; contract: { id: string; status: string } };
    expect(body.success).toBe(true);
    expect(body.contract.status).toBe("draft");
    createdIds.push(body.contract.id);
    return body.contract.id;
  };

  const move = (id: string, status: string, extra: Record<string, string> = {}, asOwner = false) =>
    app.request(`/api/contracts/${id}/status`, {
      method: "PATCH",
      headers: asOwner ? owner : ops,
      body: JSON.stringify({ status, ...extra }),
    });

  it("walks draft → review → sent → owner-signed with reviewer flags", async () => {
    const id = await draftContract("Contrato sitio web TEST");

    const r1 = await move(id, "in_review");
    expect(r1.status).toBe(200);

    const r2 = await move(id, "sent");
    expect(r2.status).toBe(200);

    const ownerSign = await move(id, "signed", {}, true);
    expect(ownerSign.status).toBe(200);
    const signedBody = (await ownerSign.json()) as { success: boolean; contract: { status: string } };
    expect(signedBody.contract.status).toBe("signed");
  });

  it("rejects signing without the owner scope", async () => {
    const id = await draftContract("Contrato firma ops TEST");
    await move(id, "in_review");
    await move(id, "sent");

    const res = await move(id, "signed");
    expect(res.status).toBe(403);
  });

  it("rejects bad jumps and stores the void reason", async () => {
    const id = await draftContract("Contrato salto TEST");

    const jump = await move(id, "signed", {}, true);
    expect(jump.status).toBe(400);

    const back = await move(id, "draft");
    expect(back.status).toBe(400);

    const voided = await move(id, "void", { reason: "Cliente desistió" });
    expect(voided.status).toBe(200);
    const [row] = await db.select().from(contracts).where(eq(contracts.id, id)).limit(1);
    expect(row?.status).toBe("void");
    expect(row?.voidReason).toBe("Cliente desistió");

    const voidNoReason = await move(await draftContract("Contrato sin motivo TEST"), "void");
    expect(voidNoReason.status).toBe(400);
  });
});
