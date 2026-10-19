import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmSaveContract } from "../lib/crm";

export default defineTool({
  description:
    "Save a service contract draft in Creapolis CRM against its lead or project: title, full body, and reviewer flags (client legal entity, jurisdiction, amounts needing human review). Drafts always start in 'draft' and only move forward through review. Never invent client legal details: flag them in reviewerNote instead.",
  inputSchema: z.object({
    leadId: z.string().uuid().optional().describe("Lead UUID the contract belongs to"),
    projectId: z.string().uuid().optional().describe("Project UUID for existing-client contracts"),
    title: z.string().min(1).describe("Contract title (e.g. 'Desarrollo App Móvil — Fase 1')"),
    body: z.string().min(1).describe("Full contract text with scope, payments, IP, confidentiality, termination"),
    reviewerNote: z
      .string()
      .optional()
      .describe("What the human reviewer must verify before this leaves draft (entity, jurisdiction, amounts)"),
    createdBy: z.string().describe("Author tag, e.g. legal:chat"),
  }),
  async execute(input) {
    try {
      const result = await crmSaveContract({
        leadId: input.leadId,
        projectId: input.projectId,
        title: input.title,
        body: input.body,
        reviewerNote: input.reviewerNote,
        createdBy: input.createdBy,
      });

      return {
        status: "contract_drafted",
        contractId: result.contract.id,
        message: "Contract draft persisted in 'draft' with reviewer flags.",
      };
    } catch (err) {
      return {
        status: "contract_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
