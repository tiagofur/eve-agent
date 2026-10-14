/**
 * Lead stage state machine.
 *
 * Pure domain logic with no I/O, so the API can enforce it and tests can pin it down.
 * Agents can be wrong; the server cannot. Every stage change must pass through here.
 */

export const LEAD_STAGES = [
  "new",
  "researched",
  "contacted",
  "qualified",
  "discovery",
  "proposal",
  "contract",
  "won",
  "lost",
  "onboarding",
  "active",
  "support",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

/**
 * Allowed moves. `new` may jump ahead because an inbound lead (someone who writes to the
 * front agent) arrives already talking to us and does not need research or cold outreach.
 */
const TRANSITIONS: Record<LeadStage, readonly LeadStage[]> = {
  new: ["researched", "contacted", "qualified", "lost"],
  researched: ["contacted", "lost"],
  contacted: ["qualified", "lost"],
  qualified: ["discovery", "lost"],
  discovery: ["proposal", "lost"],
  proposal: ["contract", "discovery", "lost"],
  contract: ["won", "lost"],
  won: ["onboarding"],
  // A lost lead can re-enter the funnel from the top, with a reason.
  lost: ["new"],
  onboarding: ["active"],
  active: ["support"],
  support: ["active"],
};

/** Funnel order for conversion metrics. Terminal/post-sale stages are excluded on purpose. */
export const FUNNEL_STAGES = [
  "new",
  "researched",
  "contacted",
  "qualified",
  "discovery",
  "proposal",
  "contract",
  "won",
] as const satisfies readonly LeadStage[];

export interface TransitionInput {
  from: LeadStage;
  to: LeadStage;
  /** Why the stage is changing. Required for every transition (it feeds the audit log). */
  reason?: string | undefined;
  /** Required when moving to `lost`; feeds the improvement suggestions. */
  lostReason?: string | undefined;
}

export type TransitionResult = { ok: true } | { ok: false; code: TransitionErrorCode; message: string };

export type TransitionErrorCode =
  | "same_stage"
  | "invalid_transition"
  | "reason_required"
  | "lost_reason_required";

export function allowedNextStages(from: LeadStage): readonly LeadStage[] {
  return TRANSITIONS[from];
}

export function validateTransition(input: TransitionInput): TransitionResult {
  const { from, to } = input;

  if (from === to) {
    return { ok: false, code: "same_stage", message: `Lead is already in stage "${from}".` };
  }

  if (!TRANSITIONS[from].includes(to)) {
    const allowed = TRANSITIONS[from].join(", ");
    return {
      ok: false,
      code: "invalid_transition",
      message: `Cannot move a lead from "${from}" to "${to}". Allowed next stages: ${allowed}.`,
    };
  }

  if (!input.reason || input.reason.trim().length === 0) {
    return {
      ok: false,
      code: "reason_required",
      message: "A reason is required for every stage change.",
    };
  }

  if (to === "lost" && (!input.lostReason || input.lostReason.trim().length === 0)) {
    return {
      ok: false,
      code: "lost_reason_required",
      message: "A lostReason is required when moving a lead to \"lost\".",
    };
  }

  return { ok: true };
}
