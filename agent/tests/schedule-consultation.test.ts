import { describe, it, expect, vi, afterEach } from "vitest";
import type { ToolContext } from "eve/tools";

// The real Google integration never runs here: each test decides what the
// calendar would have answered, so no event or invitation can leave the machine.
const consultation = vi.hoisted(() => ({ result: undefined as unknown }));

vi.mock("../lib/google-calendar", () => ({
  scheduleConsultation: vi.fn(async () => consultation.result),
}));

import { scheduleConsultation } from "../lib/google-calendar";
import tool from "../tools/schedule_consultation";

const PUBLIC_USER = process.env.EVE_PUBLIC_USER?.trim() || "creapolis-public";

function ctx(sessionId: string, principalId: string): ToolContext {
  return {
    session: { id: sessionId, auth: { current: { authenticator: "http-basic", principalId } } },
  } as unknown as ToolContext;
}

const booking = {
  clientName: "Prospecto de prueba",
  contact: "prospecto@ejemplo.com",
  preferredDate: "2030-01-15",
  preferredTimeSlot: "10:00 AM",
  discussionTopics: ["Automatización de leads"],
};

const SCHEDULED = { ok: true, status: "scheduled", message: "Consulta agendada." };
const BUSY = { ok: false, status: "needs_new_slot", message: "Ocupado.", alternatives: [] };
const NOT_CONFIGURED = { ok: false, status: "not_configured", message: "Google Calendar no configurado." };

/** The tool settles with one result; a streamed result would be a wiring bug. */
async function book(input: typeof booking, ctx: ToolContext): Promise<{ status: string; limit?: string }> {
  const out = await tool.execute(input, ctx);
  if (Symbol.asyncIterator in out) throw new Error("la tool no debería transmitir su resultado");
  return out;
}

describe("schedule_consultation wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(scheduleConsultation).mockClear();
  });

  it("refuses a public session past its booking budget without touching the calendar", async () => {
    consultation.result = SCHEDULED;
    const visitor = ctx("wiring-1", PUBLIC_USER);
    expect((await book(booking, visitor)).status).toBe("scheduled");
    expect((await book(booking, visitor)).status).toBe("scheduled");
    const refused = await book(booking, visitor);
    expect(refused).toMatchObject({ ok: false, status: "booking_limit_reached", limit: "session" });
    expect(scheduleConsultation).toHaveBeenCalledTimes(2);
  });

  it("does not charge a slot that was not booked", async () => {
    consultation.result = BUSY;
    const visitor = ctx("wiring-2", PUBLIC_USER);
    for (let i = 0; i < 4; i++) {
      expect((await book(booking, visitor)).status).toBe("needs_new_slot");
    }
    consultation.result = SCHEDULED;
    expect((await book(booking, visitor)).status).toBe("scheduled");
  });

  it("gives the unit back when the calendar is not configured or fails", async () => {
    consultation.result = NOT_CONFIGURED;
    const visitor = ctx("wiring-3", PUBLIC_USER);
    expect((await book(booking, visitor)).status).toBe("not_configured");
    vi.mocked(scheduleConsultation).mockRejectedValueOnce(new Error("Calendar respondió HTTP 500"));
    expect((await book(booking, visitor)).status).toBe("failed");
    consultation.result = SCHEDULED;
    expect((await book(booking, visitor)).status).toBe("scheduled");
  });

  it("never refuses a staff session", async () => {
    consultation.result = SCHEDULED;
    const owner = ctx("wiring-4", "eve-service-user");
    for (let i = 0; i < 6; i++) {
      expect((await book(booking, owner)).status).toBe("scheduled");
    }
    expect(scheduleConsultation).toHaveBeenCalledTimes(6);
  });
});
