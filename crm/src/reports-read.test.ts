import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq, like } from "drizzle-orm";
import { pool, db } from "./db/client";
import { analystReports, apiKeys } from "./db/schema";
import { hashApiKey } from "./auth/keys";
import { app } from "./app";

/**
 * Owner triage on analyst reports (Mission Control "Reportes"): unread
 * count and the read/unread mark endpoints.
 */
describe("Analyst reports: leído / no leído", () => {
  const opsKey = "cp_ops_reportsread1234567890abcdef0";
  const opsHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${opsKey}` };
  let unreadId = "";
  let readId = "";

  beforeAll(async () => {
    await db.insert(apiKeys).values([{ name: "Reports Read Test", scope: "ops", keyHash: hashApiKey(opsKey) }]);
    const [unread] = await db
      .insert(analystReports)
      .values({ summary: "# TEST sin leer\n\nCuerpo del brief.", createdBy: "intel:test" })
      .returning();
    unreadId = unread!.id;
    const [read] = await db
      .insert(analystReports)
      .values({ summary: "# TEST leído", createdBy: "analyst:test", readAt: new Date() })
      .returning();
    readId = read!.id;
  });

  afterAll(async () => {
    await db.delete(analystReports).where(like(analystReports.createdBy, "%:test"));
    await db.delete(apiKeys).where(eq(apiKeys.keyHash, hashApiKey(opsKey)));
    await pool.end();
  });

  it("requires auth", async () => {
    const res = await app.request("/api/reports/analyst/unread-count");
    expect(res.status).toBe(401);
  });

  it("unread-count cuenta solo los sin read_at", async () => {
    const res = await app.request("/api/reports/analyst/unread-count", { headers: opsHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unread: number };
    // At least our unread one; other tests may leave rows too.
    expect(body.unread).toBeGreaterThanOrEqual(1);
    const list = await app.request("/api/reports/analyst?limit=100", { headers: opsHeaders });
    const { reports } = (await list.json()) as { reports: Array<{ id: string; readAt: string | null }> };
    const mine = reports.find((r) => r.id === readId);
    expect(mine?.readAt).not.toBeNull();
  });

  it("mark read persiste read_at y mark unread lo borra; 404 si no existe", async () => {
    const markRead = await app.request(`/api/reports/analyst/${unreadId}/read`, {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({ read: true }),
    });
    expect(markRead.status).toBe(200);
    const readBody = (await markRead.json()) as { readAt: string | null };
    expect(readBody.readAt).not.toBeNull();

    const markUnread = await app.request(`/api/reports/analyst/${unreadId}/read`, {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({ read: false }),
    });
    expect(markUnread.status).toBe(200);
    const unreadBody = (await markUnread.json()) as { readAt: string | null };
    expect(unreadBody.readAt).toBeNull();

    const missing = await app.request(`/api/reports/analyst/${randomUUID()}/read`, {
      method: "POST",
      headers: opsHeaders,
      body: JSON.stringify({ read: true }),
    });
    expect(missing.status).toBe(404);
  });
});
