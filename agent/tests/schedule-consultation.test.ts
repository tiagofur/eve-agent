import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "eve/tools";

// The real Google integration never runs here: each test decides what the
// calendar would have answered, so no event or invitation can leave the machine.
const consultation = vi.hoisted(() => ({ result: undefined as unknown }));

vi.mock("../lib/google-calendar", () => ({
  scheduleConsultation: vi.fn(async () => consultation.result),
}));

type Limits = typeof import("../lib/booking-limits");

// A limiter of this file's own, so the bookings a test keeps never leak into
// another test through the process-wide one.
vi.mock("../lib/booking-limits", async (importOriginal) => {
  const actual = await importOriginal<Limits>();
  return { ...actual, bookingLimiter: actual.createBookingLimiter() };
});

import { scheduleConsultation } from "../lib/google-calendar";
import tool from "../tools/schedule_consultation";

const PUBLIC_USER = process.env.EVE_PUBLIC_USER?.trim() || "creapolis-public";

type Principal = { authenticator: string; principalId: string } | null;

function ctx(sessionId: string, principal: Principal): ToolContext {
  return { session: { id: sessionId, auth: { current: principal } } } as unknown as ToolContext;
}

const visitor = (id: string) => ctx(id, { authenticator: "http-basic", principalId: PUBLIC_USER });
const whatsapp = (id: string) => ctx(id, { authenticator: "whatsapp", principalId: "5511999999999" });
const staff = (id: string) => ctx(id, { authenticator: "http-basic", principalId: "eve-service-user" });

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
// What lib/google-calendar returns for most failures: it settles, it does not throw.
const FAILED = { ok: false, status: "failed", message: "Calendar respondió HTTP 500." };

/** The tool settles with one result; a streamed result would be a wiring bug. */
async function book(input: typeof booking, ctx: ToolContext): Promise<{ status: string; limit?: string }> {
  const out = await tool.execute(input, ctx);
  if (Symbol.asyncIterator in out) throw new Error("la tool no debería transmitir su resultado");
  return out;
}

const DAY = new Date("2030-01-10T15:00:00Z");

describe("schedule_consultation wiring", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // A fixed clock keeps every test on the same UTC day; the daily-cap test moves it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DAY);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
    vi.mocked(scheduleConsultation).mockClear();
  });

  it("refuses a public session past its booking budget without touching the calendar", async () => {
    consultation.result = SCHEDULED;
    const session = visitor("wiring-1");
    expect((await book(booking, session)).status).toBe("scheduled");
    expect((await book(booking, session)).status).toBe("scheduled");
    const refused = await book(booking, session);
    expect(refused).toMatchObject({ ok: false, status: "booking_limit_reached", limit: "session" });
    expect(scheduleConsultation).toHaveBeenCalledTimes(2);
  });

  it("does not charge a slot that was not booked", async () => {
    consultation.result = BUSY;
    const session = visitor("wiring-2");
    for (let i = 0; i < 4; i++) {
      expect((await book(booking, session)).status).toBe("needs_new_slot");
    }
    consultation.result = SCHEDULED;
    expect((await book(booking, session)).status).toBe("scheduled");
  });

  it("gives the unit back for every outcome that created no event", async () => {
    const session = visitor("wiring-3");
    consultation.result = FAILED;
    expect((await book(booking, session)).status).toBe("failed");
    consultation.result = NOT_CONFIGURED;
    expect((await book(booking, session)).status).toBe("not_configured");
    vi.mocked(scheduleConsultation).mockRejectedValueOnce(new Error("Calendar respondió HTTP 500"));
    expect((await book(booking, session)).status).toBe("failed");
    consultation.result = SCHEDULED;
    expect((await book(booking, session)).status).toBe("scheduled");
  });

  it("applies the daily cap across sessions", async () => {
    // A new UTC day starts the daily budget from zero.
    vi.setSystemTime(new Date(DAY.getTime() + 86_400_000));
    process.env.PUBLIC_BOOKING_DAILY_CAP = "2";
    consultation.result = SCHEDULED;
    expect((await book(booking, visitor("daily-a"))).status).toBe("scheduled");
    expect((await book(booking, visitor("daily-b"))).status).toBe("scheduled");
    const refused = await book(booking, visitor("daily-c"));
    expect(refused).toMatchObject({ ok: false, status: "booking_limit_reached", limit: "daily" });
    expect(scheduleConsultation).toHaveBeenCalledTimes(2);
  });

  it("limits whatsapp senders and sessions without a principal", async () => {
    consultation.result = SCHEDULED;
    const sender = whatsapp("wiring-wa");
    const anonymous = ctx("wiring-anon", null);
    for (const session of [sender, anonymous]) {
      expect((await book(booking, session)).status).toBe("scheduled");
      expect((await book(booking, session)).status).toBe("scheduled");
      expect((await book(booking, session)).status).toBe("booking_limit_reached");
    }
    expect(scheduleConsultation).toHaveBeenCalledTimes(4);
  });

  it("lets only the budgeted bookings through when a turn fires calls in parallel", async () => {
    consultation.result = SCHEDULED;
    const session = visitor("wiring-par");
    const outcomes = await Promise.all([book(booking, session), book(booking, session), book(booking, session)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual([
      "booking_limit_reached",
      "scheduled",
      "scheduled",
    ]);
    expect(scheduleConsultation).toHaveBeenCalledTimes(2);
  });

  it("never refuses a staff session", async () => {
    consultation.result = SCHEDULED;
    const owner = staff("wiring-staff");
    for (let i = 0; i < 6; i++) {
      expect((await book(booking, owner)).status).toBe("scheduled");
    }
    expect(scheduleConsultation).toHaveBeenCalledTimes(6);
  });
});
