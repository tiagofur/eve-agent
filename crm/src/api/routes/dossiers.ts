import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { dossiers } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { createDossier } from "../../domain/dossiers";

export const dossiersRouter = new Hono<{ Variables: AuthContextVariables }>();

dossiersRouter.post(
  "/",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      leadId: z.string().uuid().optional(),
      organizationId: z.string().uuid().optional(),
      companyName: z.string().optional(),
      domain: z.string().optional(),
      googlePlaceId: z.string().optional(),
      summary: z.string().min(1),
      findings: z.record(z.string(), z.unknown()).default({}),
      sources: z
        .array(
          z.object({
            url: z.string().min(1),
            retrievedAt: z.string(),
            note: z.string().optional(),
          })
        )
        .min(1, "At least one verified source URL is required"),
      contact: z
        .object({
          name: z.string().optional(),
          email: z.string().optional(),
          phone: z.string().optional(),
        })
        .optional(),
    })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const actor = c.get("actor");

    const dossier = await createDossier({
      ...data,
      actor,
    });

    return c.json({ success: true, dossier }, 201);
  }
);

dossiersRouter.get("/organization/:orgId", requireScope(["ops"]), async (c) => {
  const orgId = c.req.param("orgId");
  const result = await db
    .select()
    .from(dossiers)
    .where(sql`${dossiers.organizationId} = ${orgId}`)
    .orderBy(desc(dossiers.createdAt));

  return c.json({ dossiers: result });
});
