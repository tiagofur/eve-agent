import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { reportIncident, resolveIncident, type IncidentSource } from "../../domain/incidents";

/**
 * Public webhook surface for infrastructure incidents (own CI, uptime
 * monitors). No API key: authenticity comes from INCIDENT_WEBHOOK_SECRET,
 * accepted as Authorization: Bearer or ?secret= (monitor services cannot
 * always set headers). Fails closed — without the env it answers 503.
 */
export const webhooksRouter = new Hono();

const SOURCES: IncidentSource[] = ["github_ci", "uptime", "manual"];

function secretValid(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }): boolean {
  const secret = process.env.INCIDENT_WEBHOOK_SECRET?.trim();
  if (!secret) return false;
  const header = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return secretValid(secret, header) || secretValid(secret, c.req.query("secret"));
}

const incidentSchema = z.object({
  source: z.enum(["github_ci", "uptime", "manual"]),
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  description: z.string().max(4000).optional(),
  url: z.string().url().max(500).optional(),
  severity: z.enum(["critical", "major", "minor"]).optional(),
});

webhooksRouter.post("/incidents", zValidator("json", incidentSchema), async (c) => {
  if (!authorized(c)) {
    return c.json(
      { error: "Incident webhook is not configured or the secret is wrong" },
      process.env.INCIDENT_WEBHOOK_SECRET?.trim() ? 401 : 503
    );
  }
  const data = c.req.valid("json");
  const result = await reportIncident(data);
  return c.json(result);
});

// GET variant for uptime monitors that ping a plain URL with placeholders
// (Healthchecks.io style: /incidents?source=uptime&key={KEY}&name={NAME}&status={STATUS}).
webhooksRouter.get("/incidents", async (c) => {
  if (!authorized(c)) {
    return c.json(
      { error: "Incident webhook is not configured or the secret is wrong" },
      process.env.INCIDENT_WEBHOOK_SECRET?.trim() ? 401 : 503
    );
  }
  const source = (c.req.query("source") ?? "uptime") as IncidentSource;
  if (!SOURCES.includes(source)) return c.json({ error: "Unknown source" }, 400);
  const key = c.req.query("key");
  if (!key) return c.json({ error: "Missing key" }, 400);
  const status = c.req.query("status") ?? "down";
  const name = c.req.query("name") ?? key;

  if (status === "up" || status === "ok") {
    return c.json(await resolveIncident(source, key));
  }
  const result = await reportIncident({
    source,
    key,
    title: `${name} está caído`,
    description: `Monitor reportó "${status}" para ${name} (${key}).`,
    url: c.req.query("url") || undefined,
    severity: (c.req.query("severity") as "critical" | "major" | "minor" | undefined) ?? undefined,
  });
  return c.json(result);
});
