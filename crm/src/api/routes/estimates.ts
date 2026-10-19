import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { estimates } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";

export const estimatesRouter = new Hono<{ Variables: AuthContextVariables }>();

const CATEGORIES = [
  "web_mobile_app",
  "workflow_automation",
  "enterprise_ai_agent",
  "full_system_integration",
] as const;
const COMPLEXITIES = ["mvp", "standard", "enterprise"] as const;

// Save a technical proposal against its lead/organization (ops only).
// Money appears only when quoted: valueCents null means not agreed.
estimatesRouter.post(
  "/",
  requireScope(["ops"]),
  zValidator(
    "json",
    z
      .object({
        leadId: z.string().uuid().optional(),
        organizationId: z.string().uuid().optional(),
        category: z.enum(CATEGORIES),
        complexity: z.enum(COMPLEXITIES),
        scopeSummary: z.string().min(1),
        phases: z
          .array(z.object({ title: z.string().min(1), timeframe: z.string().optional() }))
          .default([]),
        timelineText: z.string().optional(),
        valueCents: z.number().int().nonnegative().nullable().optional(),
        currency: z.string().max(8).default("USD"),
        createdBy: z.string().min(1),
      })
      .refine((d) => d.leadId || d.organizationId, {
        message: "An estimate must target a lead or an organization.",
      })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const [estimate] = await db
      .insert(estimates)
      .values({
        leadId: data.leadId,
        organizationId: data.organizationId,
        category: data.category,
        complexity: data.complexity,
        scopeSummary: data.scopeSummary,
        phases: data.phases,
        timelineText: data.timelineText,
        valueCents: data.valueCents ?? null,
        currency: data.currency,
        createdBy: data.createdBy,
      })
      .returning();

    return c.json({ success: true, estimate }, 201);
  }
);

// List estimates, newest first, optionally filtered by lead or organization.
estimatesRouter.get("/", requireScope(["ops"]), async (c) => {
  const leadId = c.req.query("leadId");
  const organizationId = c.req.query("organizationId");
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);

  const conditions = [];
  if (leadId) conditions.push(sql`${estimates.leadId} = ${leadId}`);
  if (organizationId) conditions.push(sql`${estimates.organizationId} = ${organizationId}`);

  const rows = await db
    .select()
    .from(estimates)
    .where(conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined)
    .orderBy(desc(estimates.createdAt))
    .limit(limit);

  return c.json({ estimates: rows });
});

// Fetch one estimate by id.
estimatesRouter.get("/:id", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  const [estimate] = await db.select().from(estimates).where(sql`${estimates.id} = ${id}`).limit(1);
  if (!estimate) {
    return c.json({ error: "Estimate not found" }, 404);
  }
  return c.json({ estimate });
});
