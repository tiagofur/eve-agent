import type { ToolContext } from "eve/tools";
import { isPublicCaller } from "./guard";

/**
 * Mechanical budget for public bookings. `schedule_consultation` is the only
 * public tool with an external side effect: every call that succeeds takes a
 * real slot on the owner's calendar and mails an invitation, and the generic
 * chat limits (CRM: 20 turns / 10 min per IP, 60 per thread) still let one
 * visitor fill every free slot of a week. So bookings get their own caps:
 *
 *   - per session: a genuine prospect books once, at most twice when the
 *     first slot does not fit. More than that in one conversation is bulk
 *     booking, not a lead.
 *   - per day across all limited sessions: bounds lost slots and outgoing
 *     invitations no matter how many threads or senders an abuser opens.
 *
 * Only an explicitly authenticated staff principal is exempt. A session with
 * no principal (delegated subagent, headless run) is limited too: it cannot
 * prove it is staff.
 *
 * In-memory like the WhatsApp throttle: a restart resets the counters, which
 * only briefly widens the window.
 */

const DEFAULT_SESSION_CAP = 2;
const DEFAULT_DAILY_CAP = 8;

export interface BookingLimits {
  sessionCap: number;
  dailyCap: number;
}

export type BookingLimit = "session" | "daily";

export type BookingPermit =
  | { ok: true; release: () => void }
  | { ok: false; limit: BookingLimit; cap: number };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Read per call so tests and a restarted process pick up env changes. */
export function readBookingLimits(env: NodeJS.ProcessEnv = process.env): BookingLimits {
  return {
    sessionCap: positiveInt(env.PUBLIC_BOOKING_MAX_PER_SESSION, DEFAULT_SESSION_CAP),
    dailyCap: positiveInt(env.PUBLIC_BOOKING_DAILY_CAP, DEFAULT_DAILY_CAP),
  };
}

/** Staff sessions book freely; public callers and unauthenticated sessions are capped. */
export function isBookingLimited(ctx: ToolContext): boolean {
  return !ctx.session.auth.current || isPublicCaller(ctx);
}

export function createBookingLimiter() {
  const bySession = new Map<string, number>();
  const byDay = new Map<string, number>();

  function bump(map: Map<string, number>, key: string, delta: number): void {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  return {
    /**
     * Takes one booking from the caller's budgets before the calendar is
     * touched, so two calls in the same turn cannot both slip past the cap.
     * `release` gives the unit back when no event was created.
     */
    reserve(ctx: ToolContext, now: Date = new Date()): BookingPermit {
      if (!isBookingLimited(ctx)) return { ok: true, release: () => {} };
      const { sessionCap, dailyCap } = readBookingLimits();
      const day = now.toISOString().slice(0, 10);
      for (const key of byDay.keys()) {
        if (key !== day) byDay.delete(key);
      }
      if ((byDay.get(day) ?? 0) >= dailyCap) return { ok: false, limit: "daily", cap: dailyCap };
      const sessionId = ctx.session.id;
      if ((bySession.get(sessionId) ?? 0) >= sessionCap) {
        return { ok: false, limit: "session", cap: sessionCap };
      }
      bump(byDay, day, 1);
      bump(bySession, sessionId, 1);
      let released = false;
      return {
        ok: true,
        release: () => {
          // Idempotent: a second call would take a unit from another booking.
          if (released) return;
          released = true;
          bump(byDay, day, -1);
          bump(bySession, sessionId, -1);
        },
      };
    },
  };
}

/** Process-wide limiter the booking tool uses. */
export const bookingLimiter = createBookingLimiter();

/** What the model reads when a booking is refused: the event was never created. */
export function bookingLimitMessage(limit: BookingLimit, cap: number): string {
  const scope =
    limit === "session"
      ? `Esta conversación ya alcanzó su límite de reservas (${cap}).`
      : `El chat alcanzó su límite diario de reservas (${cap}).`;
  return (
    `${scope} La cita NO se creó. No intentes otro horario ni repitas la reserva: ` +
    "toma el nombre y un correo o WhatsApp del prospecto, regístralo con register_lead y " +
    "dile que el equipo de Creapolis.Dev le escribirá para confirmar la cita."
  );
}
