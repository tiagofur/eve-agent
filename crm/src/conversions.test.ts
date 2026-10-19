import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, leads, organizations } from "./db/schema";
import { eq } from "drizzle-orm";

/**
 * Real conversions (S1): edges, rates, time-in-stage and loss reasons must
 * come from the transition history of LIVE leads — never from snapshot
 * stocks, and test-actor noise must not leak in.
 */
describe("conversions from live-lead transition history", () => {
  const opsKey = "cp_ops_convtestkey1234567890abcdef12";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  let orgId = "";

  const moveStage = async (leadId: string, targetStage: string, extra: Record<string, string> = {}) => {
    const moved = await app.request(`/api/leads/${leadId}/stage`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ targetStage, reason: "test E2E", ...extra }),
    });
    expect(moved.status).toBe(200);
  };

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Conv Test", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const [org] = await db.insert(organizations).values({ name: "TEST-Conv Engine" }).returning();
    orgId = org!.id;

    // Lead A: new -> researched -> contacted
    const [a] = await db
      .insert(leads)
      .values({ organizationId: orgId, stage: "new", source: "test", summary: "Conv A" })
      .returning();
    await moveStage(a!.id, "researched");
    await moveStage(a!.id, "contacted");

    // Lead B: new -> researched -> lost (budget)
    const [b] = await db
      .insert(leads)
      .values({ organizationId: orgId, stage: "new", source: "test", summary: "Conv B" })
      .returning();
    await moveStage(b!.id, "researched");
    await moveStage(b!.id, "lost", { lostReason: "budget" });

    // Lead C: stays new (entry only)
    await db
      .insert(leads)
      .values({ organizationId: orgId, stage: "new", source: "test", summary: "Conv C" });
  });

  afterAll(async () => {
    await db.delete(leads).where(eq(leads.organizationId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("reports edges, honest rates, time-in-stage and loss reasons", async () => {
    const res = await app.request("/api/reports/conversions", { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sampleSize: number;
      sufficientData: boolean;
      minSample: number;
      entries: Record<string, number>;
      edges: Array<{ from: string; to: string; count: number; rate: number }>;
      medianMsInStage: Record<string, number>;
      lossReasons: Array<{ reason: string; count: number }>;
    };

    expect(body.sampleSize).toBeGreaterThanOrEqual(3);
    expect(body.minSample).toBeGreaterThanOrEqual(3);
    expect(body.entries["new"]).toBeGreaterThanOrEqual(3);

    const edge = (from: string, to: string) => body.edges.find((e) => e.from === from && e.to === to);
    expect(edge("new", "researched")!.count).toBeGreaterThanOrEqual(2);
    expect(edge("researched", "contacted")!.count).toBeGreaterThanOrEqual(1);
    expect(edge("researched", "lost")!.count).toBeGreaterThanOrEqual(1);

    // Rates are per-entry flow-through, bounded and consistent with counts.
    for (const e of body.edges) {
      expect(e.rate).toBeGreaterThanOrEqual(0);
      expect(e.rate).toBeLessThanOrEqual(1);
      expect(e.rate).toBeCloseTo(e.count / (body.entries[e.from] ?? 1), 5);
    }

    expect(body.lossReasons).toEqual(
      expect.arrayContaining([{ reason: "budget", count: expect.any(Number) }])
    );
    expect(typeof body.medianMsInStage["new"]).toBe("number");
    expect(typeof body.medianMsInStage["researched"]).toBe("number");
  });

  it("marks small samples as insufficient instead of implying confidence", async () => {
    const res = await app.request("/api/reports/conversions", { headers });
    const body = (await res.json()) as { sampleSize: number; sufficientData: boolean; minSample: number };
    // Parallel test files seed transient TEST leads, so the absolute count
    // is not deterministic here: pin the contract instead — the published
    // policy threshold, and the flag as a pure function of the sample.
    expect(body.minSample).toBe(10);
    expect(body.sufficientData).toBe(body.sampleSize >= body.minSample);
  });
});
