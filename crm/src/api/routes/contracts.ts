import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { desc, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { contracts } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { createContract, moveContractStatus } from "../../domain/contracts";

export const contractsRouter = new Hono<{ Variables: AuthContextVariables }>();

// Draft a contract (ops and front): always starts in `draft`.
contractsRouter.post(
  "/",
  requireScope(["front", "ops"]),
  zValidator(
    "json",
    z
      .object({
        leadId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        title: z.string().min(1),
        body: z.string().min(1),
        reviewerNote: z.string().max(2000).optional(),
        createdBy: z.string().min(1),
      })
      .refine((d) => d.leadId || d.projectId, {
        message: "A contract must target a lead or a project.",
      })
  ),
  async (c) => {
    const data = c.req.valid("json");
    const result = await createContract(data);

    if (!result.success) {
      return c.json({ error: result.message, code: result.code }, 400);
    }
    return c.json({ success: true, contract: result.contract }, 201);
  }
);

// Move a contract through the strict machine. Signing (and voiding a
// signed contract) requires the owner scope; voiding requires a reason.
contractsRouter.patch(
  "/:id/status",
  requireScope(["front", "ops"]),
  zValidator(
    "json",
    z.object({
      status: z.enum(["draft", "in_review", "sent", "signed", "void"]),
      reason: z.string().max(1000).optional(),
      reviewerNote: z.string().max(2000).optional(),
    })
  ),
  async (c) => {
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const actor = c.get("actor");
    const actorIsOwner = c.get("apiKeyScope") === "owner";

    const result = await moveContractStatus({
      contractId: id,
      targetStage: data.status,
      reason: data.reason,
      reviewerNote: data.reviewerNote,
      actor,
      actorIsOwner,
    });

    if (!result.success) {
      const status = result.code === "not_found" ? 404 : result.code === "owner_only" ? 403 : 400;
      return c.json({ error: result.message, code: result.code }, status as 400);
    }
    return c.json({ success: true, contract: result.contract });
  }
);

// List contracts, newest first, optionally filtered by lead, project or status.
contractsRouter.get("/", requireScope(["ops"]), async (c) => {
  const leadId = c.req.query("leadId");
  const projectId = c.req.query("projectId");
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 100);

  const conditions = [];
  if (leadId) conditions.push(sql`${contracts.leadId} = ${leadId}`);
  if (projectId) conditions.push(sql`${contracts.projectId} = ${projectId}`);
  if (status) conditions.push(sql`${contracts.status} = ${status}`);

  const rows = await db
    .select()
    .from(contracts)
    .where(conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined)
    .orderBy(desc(contracts.createdAt))
    .limit(limit);

  return c.json({ contracts: rows });
});
