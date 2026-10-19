import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { contracts, type ContractStatus } from "../db/schema";
import { logEvent } from "./events";

export type ContractTransition = ContractStatus;

/** Strict machine (S1): draft → in_review → sent → signed; void with reason. */
const ALLOWED: Record<ContractStatus, ContractStatus[]> = {
  draft: ["in_review", "void"],
  in_review: ["sent", "void"],
  sent: ["signed", "void"],
  signed: ["void"],
  void: [],
};

export function validateContractTransition(from: ContractStatus, to: ContractStatus): { ok: true } | { ok: false; message: string } {
  if (from === to) return { ok: false, message: `Contract is already ${from}` };
  if (!ALLOWED[from].includes(to)) {
    return { ok: false, message: `Invalid contract transition: ${from} → ${to}` };
  }
  return { ok: true };
}

export interface CreateContractInput {
  leadId?: string;
  projectId?: string;
  title: string;
  body: string;
  reviewerNote?: string;
  createdBy: string;
}

export async function createContract(input: CreateContractInput) {
  if (!input.leadId && !input.projectId) {
    return {
      success: false as const,
      code: "target_required",
      message: "A contract must target a lead or a project.",
    };
  }

  const [contract] = await db
    .insert(contracts)
    .values({
      leadId: input.leadId,
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      status: "draft",
      reviewerNote: input.reviewerNote,
    })
    .returning();

  if (!contract) throw new Error("Failed to create contract");

  await logEvent({
    entity: "contract",
    entityId: contract.id,
    action: "contract_created",
    actor: input.createdBy,
    after: { status: "draft", title: input.title },
  });

  return { success: true as const, contract };
}

export interface MoveContractInput {
  contractId: string;
  targetStage: ContractStatus;
  reason?: string;
  reviewerNote?: string;
  actor: string;
  actorIsOwner: boolean;
}

export async function moveContractStatus(input: MoveContractInput) {
  const [current] = await db.select().from(contracts).where(eq(contracts.id, input.contractId)).limit(1);
  if (!current) {
    return { success: false as const, code: "not_found", message: "Contract not found" };
  }

  const validation = validateContractTransition(current.status as ContractStatus, input.targetStage);
  if (!validation.ok) {
    return { success: false as const, code: "invalid_transition", message: validation.message };
  }

  // Signing (and voiding a signed contract) is a legal commitment: owner only.
  if (input.targetStage === "signed" || current.status === "signed") {
    if (!input.actorIsOwner) {
      return {
        success: false as const,
        code: "owner_only",
        message: "Only the owner can sign (or void a signed) contract.",
      };
    }
  }

  if (input.targetStage === "void" && (!input.reason || !input.reason.trim())) {
    return {
      success: false as const,
      code: "reason_required",
      message: "Voiding a contract requires a reason.",
    };
  }

  const [updated] = await db
    .update(contracts)
    .set({
      status: input.targetStage,
      reviewerNote: input.reviewerNote ?? current.reviewerNote,
      voidReason: input.targetStage === "void" ? input.reason!.trim() : current.voidReason,
      updatedAt: new Date(),
    })
    .where(eq(contracts.id, input.contractId))
    .returning();

  await logEvent({
    entity: "contract",
    entityId: input.contractId,
    action: `contract_${input.targetStage}`,
    actor: input.actor,
    before: { status: current.status },
    after: { status: input.targetStage },
    reason: input.reason ?? input.reviewerNote ?? null,
  });

  return { success: true as const, contract: updated! };
}
