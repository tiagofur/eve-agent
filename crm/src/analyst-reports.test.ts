import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { app } from "./app";
import { pool, db } from "./db/client";
import { hashApiKey } from "./auth/keys";
import { apiKeys, analystReports } from "./db/schema";
import { eq, like } from "drizzle-orm";

/**
 * Persisted analyst reports (S1): every analysis is saved with its frozen
 * metrics snapshot so trends compare saved history — never memory.
 */
describe("analyst reports persistence", () => {
  const opsKey = "cp_ops_analystrepkey1234567890abcdef";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  const MARKER = `TEST-Analyst report ${Date.now()}`;

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Analyst Rep Test", scope: "ops", keyHash: hashApiKey(opsKey) }]);
  });

  afterAll(async () => {
    await db.delete(analystReports).where(like(analystReports.summary, "TEST-Analyst report%"));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("saves a report with its metrics snapshot and lists it back", async () => {
    const created = await app.request("/api/reports/analyst", {
      method: "POST",
      headers,
      body: JSON.stringify({
        summary: `${MARKER}\n\n## Funnel\n\n3 leads en researched, muestra insuficiente.`,
        metrics: { sampleSize: 4, sufficientData: false },
        createdBy: "analyst:test",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      success: boolean;
      report: { id: string; summary: string; metrics: { sampleSize: number } };
    };
    expect(createdBody.success).toBe(true);
    expect(createdBody.report.id).toBeTruthy();
    expect(createdBody.report.metrics.sampleSize).toBe(4);

    const listed = await app.request("/api/reports/analyst", { headers });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      reports: Array<{ id: string; summary: string }>;
    };
    expect(listedBody.reports.some((r) => r.id === createdBody.report.id)).toBe(true);
  });

  it("rejects a report without the markdown briefing", async () => {
    const res = await app.request("/api/reports/analyst", {
      method: "POST",
      headers,
      body: JSON.stringify({ metrics: {}, createdBy: "analyst:test" }),
    });
    expect(res.status).toBe(400);
  });
});
