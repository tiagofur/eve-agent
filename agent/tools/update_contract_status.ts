import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmMoveContract } from "../lib/crm";

export default defineTool({
  description:
    "Move a contract through its strict machine: draft → in_review → sent. Voiding any non-terminal contract requires a reason. Signing (and voiding a signed contract) is owner-only and fails loudly through this tool: report the contract as ready-to-sign instead. Never claim a move the CRM rejected.",
  inputSchema: z.object({
    contractId: z.string().uuid().describe("Contract UUID to move"),
    status: z
      .enum(["in_review", "sent", "signed", "void"])
      .describe("Target status (draft is the starting point, never a target)"),
    reason: z
      .string()
      .optional()
      .describe("Required when voiding: why the contract is voided"),
    reviewerNote: z
      .string()
      .optional()
      .describe("Reviewer flags to attach on the move"),
  }),
  async execute(input) {
    try {
      const result = await crmMoveContract({
        contractId: input.contractId,
        status: input.status,
        reason: input.reason,
        reviewerNote: input.reviewerNote,
      });

      return {
        status: "contract_moved",
        contractId: result.contract.id,
        newStatus: result.contract.status,
        message: `Contract moved to '${result.contract.status}'.`,
      };
    } catch (err) {
      return {
        status: "contract_move_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
