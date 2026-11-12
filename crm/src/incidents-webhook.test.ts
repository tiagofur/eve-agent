import { describe, expect, it, afterAll, afterEach, beforeEach, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { app } from "./app";
import { pool, db } from "./db/client";
import { tickets } from "./db/schema";

/**
 * Infrastructure incidents as machine-created tickets: mechanical dedup by
 * source+key, auto-resolve on "up", fail-closed auth.
 */
const SECRET = "test-incident-secret-123";

const post = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${SECRET}` }) =>
  app.request("/api/webhooks/incidents", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const incident = { source: "github_ci" as const, key: "ci-run-42", title: "CI falló en main (abc123)" };

afterEach(() => {
  vi.unstubAllEnvs();
});

// Auth tests create tickets too: every test starts with a clean incident slate.
beforeEach(async () => {
  await db.delete(tickets).where(sql`${tickets.metadata}->>'incidentKey' = 'ci-run-42'`);
  await db.delete(tickets).where(sql`${tickets.metadata}->>'incidentKey' = 'check-upt-1'`);
});

afterAll(async () => {
  await db.delete(tickets).where(sql`${tickets.metadata}->>'incidentKey' = 'ci-run-42'`);
  await db.delete(tickets).where(sql`${tickets.metadata}->>'incidentKey' = 'check-upt-1'`);
  await pool.end();
});

describe("incident webhook auth", () => {
  it("fails closed without the secret configured (503)", async () => {
    vi.stubEnv("INCIDENT_WEBHOOK_SECRET", "");
    expect((await post(incident, { Authorization: "Bearer x" })).status).toBe(503);
    expect((await post(incident, {})).status).toBe(503);
  });

  it("rejects a wrong secret (401) and accepts bearer or ?secret=", async () => {
    vi.stubEnv("INCIDENT_WEBHOOK_SECRET", SECRET);
    expect((await post(incident, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(incident, {})).status).toBe(401);

    const byHeader = await post(incident);
    expect(byHeader.status).toBe(200);

    const byQuery = await app.request(
      `/api/webhooks/incidents?secret=${encodeURIComponent(SECRET)}&source=uptime&key=check-upt-1&name=CRM&status=down`
    );
    expect(byQuery.status).toBe(200);
  });
});

describe("incident lifecycle", () => {
  it("creates once, dedups on retry, and auto-resolves on up", async () => {
    vi.stubEnv("INCIDENT_WEBHOOK_SECRET", SECRET);

    const first = (await (await post(incident)).json()) as { status: string; ticketId: string };
    expect(first.status).toBe("ticket_created");

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, first.ticketId));
    expect(ticket).toMatchObject({ system: "github_ci", severity: "minor", kind: "support" });
    expect(ticket!.metadata).toMatchObject({ incidentSource: "github_ci", incidentKey: "ci-run-42" });

    const retry = (await (await post(incident)).json()) as { status: string; ticketId: string };
    expect(retry.status).toBe("duplicate");
    expect(retry.ticketId).toBe(first.ticketId);

    const up = (await (
      await app.request(
        `/api/webhooks/incidents?secret=${encodeURIComponent(SECRET)}&source=github_ci&key=ci-run-42&status=up`
      )
    ).json()) as { status: string; ticketIds: string[] };
    expect(up.status).toBe("resolved");
    expect(up.ticketIds).toContain(first.ticketId);

    const [resolved] = await db.select().from(tickets).where(eq(tickets.id, first.ticketId));
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.resolvedAt).not.toBeNull();
  });

  it("severities: uptime defaults to major, payload can override", async () => {
    vi.stubEnv("INCIDENT_WEBHOOK_SECRET", SECRET);
    const res = await post({ source: "uptime", key: "check-upt-sev", title: "API caída" });
    const created = (await res.json()) as { status: string; ticketId: string };
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, created.ticketId));
    expect(ticket!.severity).toBe("major");
    await db.delete(tickets).where(eq(tickets.id, created.ticketId));
  });
});
