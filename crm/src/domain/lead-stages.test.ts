import { describe, expect, it } from "vitest";
import {
  FUNNEL_STAGES,
  LEAD_STAGES,
  allowedNextStages,
  validateTransition,
  type LeadStage,
} from "./lead-stages";

describe("validateTransition", () => {
  it("accepts a valid forward move with a reason", () => {
    expect(validateTransition({ from: "new", to: "researched", reason: "dossier created" })).toEqual({
      ok: true,
    });
  });

  it("lets an inbound lead skip research and outreach", () => {
    expect(
      validateTransition({ from: "new", to: "qualified", reason: "qualified in WhatsApp chat" }),
    ).toEqual({ ok: true });
  });

  it("rejects skipping straight to won", () => {
    const result = validateTransition({ from: "new", to: "won", reason: "x" });
    expect(result).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("rejects jumping from proposal to won without a contract", () => {
    const result = validateTransition({ from: "proposal", to: "won", reason: "x" });
    expect(result).toMatchObject({ ok: false, code: "invalid_transition" });
  });

  it("rejects a no-op move to the same stage", () => {
    const result = validateTransition({ from: "contacted", to: "contacted", reason: "x" });
    expect(result).toMatchObject({ ok: false, code: "same_stage" });
  });

  it("requires a reason for every change", () => {
    expect(validateTransition({ from: "new", to: "researched" })).toMatchObject({
      ok: false,
      code: "reason_required",
    });
    expect(validateTransition({ from: "new", to: "researched", reason: "   " })).toMatchObject({
      ok: false,
      code: "reason_required",
    });
  });

  it("requires a lostReason when moving to lost", () => {
    expect(validateTransition({ from: "proposal", to: "lost", reason: "client declined" })).toMatchObject({
      ok: false,
      code: "lost_reason_required",
    });
    expect(
      validateTransition({
        from: "proposal",
        to: "lost",
        reason: "client declined",
        lostReason: "budget",
      }),
    ).toEqual({ ok: true });
  });

  it("allows renegotiating from proposal back to discovery", () => {
    expect(validateTransition({ from: "proposal", to: "discovery", reason: "scope changed" })).toEqual({
      ok: true,
    });
  });

  it("lets a lost lead re-enter the funnel only at the top", () => {
    expect(validateTransition({ from: "lost", to: "new", reason: "client came back" })).toEqual({
      ok: true,
    });
    expect(validateTransition({ from: "lost", to: "proposal", reason: "x" })).toMatchObject({
      ok: false,
      code: "invalid_transition",
    });
  });

  it("only lets won leads move to onboarding", () => {
    expect(allowedNextStages("won")).toEqual(["onboarding"]);
  });
});

describe("stage graph invariants", () => {
  it("defines transitions for every stage", () => {
    for (const stage of LEAD_STAGES) {
      expect(allowedNextStages(stage).length).toBeGreaterThan(0);
    }
  });

  it("only references known stages", () => {
    const known = new Set<LeadStage>(LEAD_STAGES);
    for (const stage of LEAD_STAGES) {
      for (const next of allowedNextStages(stage)) {
        expect(known.has(next)).toBe(true);
      }
    }
  });

  it("never allows a stage to transition to itself", () => {
    for (const stage of LEAD_STAGES) {
      expect(allowedNextStages(stage)).not.toContain(stage);
    }
  });

  it("every stage is reachable from new", () => {
    const seen = new Set<LeadStage>(["new"]);
    const queue: LeadStage[] = ["new"];
    while (queue.length > 0) {
      const current = queue.shift() as LeadStage;
      for (const next of allowedNextStages(current)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...LEAD_STAGES].sort());
  });

  it("funnel stages are a subset of all stages", () => {
    for (const stage of FUNNEL_STAGES) {
      expect(LEAD_STAGES).toContain(stage);
    }
  });
});
