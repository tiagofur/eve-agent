import { describe, it, expect, afterEach } from "vitest";
import type { ToolContext } from "eve/tools";
import {
  bookingLimitMessage,
  createBookingLimiter,
  isBookingLimited,
  readBookingLimits,
} from "../lib/booking-limits";

// Mirrors the username lib/guard.ts treats as the public web-chat proxy.
const PUBLIC_USER = process.env.EVE_PUBLIC_USER?.trim() || "creapolis-public";

type Principal = { authenticator: string; principalId: string };

function ctx(sessionId: string, principal: Principal | null): ToolContext {
  return { session: { id: sessionId, auth: { current: principal } } } as unknown as ToolContext;
}

const staff = (id: string) => ctx(id, { authenticator: "http-basic", principalId: "eve-service-user" });
const visitor = (id: string) => ctx(id, { authenticator: "http-basic", principalId: PUBLIC_USER });
const whatsapp = (id: string) => ctx(id, { authenticator: "whatsapp", principalId: "5511999999999" });
const anonymous = (id: string) => ctx(id, null);

const T0 = new Date("2026-11-27T15:00:00Z");
const NEXT_DAY = new Date("2026-11-28T15:00:00Z");

describe("booking-limits", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("only staff principals book freely", () => {
    expect(isBookingLimited(staff("s1"))).toBe(false);
    expect(isBookingLimited(visitor("s1"))).toBe(true);
    expect(isBookingLimited(whatsapp("s1"))).toBe(true);
    expect(isBookingLimited(anonymous("s1"))).toBe(true);
  });

  it("caps a public session at the per-session limit", () => {
    const limiter = createBookingLimiter();
    expect(limiter.reserve(visitor("a"), T0).ok).toBe(true);
    expect(limiter.reserve(visitor("a"), T0).ok).toBe(true);
    expect(limiter.reserve(visitor("a"), T0)).toEqual({ ok: false, limit: "session", cap: 2 });
  });

  it("gives each session its own budget and never caps staff", () => {
    const limiter = createBookingLimiter();
    limiter.reserve(visitor("a"), T0);
    limiter.reserve(visitor("a"), T0);
    expect(limiter.reserve(visitor("b"), T0).ok).toBe(true);
    for (let i = 0; i < 20; i++) {
      expect(limiter.reserve(staff("owner"), T0).ok).toBe(true);
    }
  });

  it("caps whatsapp and unauthenticated sessions too", () => {
    const limiter = createBookingLimiter();
    expect(limiter.reserve(whatsapp("w"), T0).ok).toBe(true);
    expect(limiter.reserve(whatsapp("w"), T0).ok).toBe(true);
    expect(limiter.reserve(whatsapp("w"), T0).ok).toBe(false);
    expect(limiter.reserve(anonymous("n"), T0).ok).toBe(true);
    expect(limiter.reserve(anonymous("n"), T0).ok).toBe(true);
    expect(limiter.reserve(anonymous("n"), T0).ok).toBe(false);
  });

  it("applies the daily cap across sessions", () => {
    process.env.PUBLIC_BOOKING_DAILY_CAP = "3";
    const limiter = createBookingLimiter();
    limiter.reserve(visitor("a"), T0);
    limiter.reserve(visitor("a"), T0);
    limiter.reserve(visitor("b"), T0);
    expect(limiter.reserve(visitor("c"), T0)).toEqual({ ok: false, limit: "daily", cap: 3 });
  });

  it("starts the daily budget over on the next UTC day", () => {
    process.env.PUBLIC_BOOKING_DAILY_CAP = "1";
    const limiter = createBookingLimiter();
    expect(limiter.reserve(visitor("a"), T0).ok).toBe(true);
    expect(limiter.reserve(visitor("b"), T0).ok).toBe(false);
    expect(limiter.reserve(visitor("b"), NEXT_DAY).ok).toBe(true);
  });

  it("does not let staff bookings consume the public daily budget", () => {
    process.env.PUBLIC_BOOKING_DAILY_CAP = "1";
    const limiter = createBookingLimiter();
    expect(limiter.reserve(staff("owner"), T0).ok).toBe(true);
    expect(limiter.reserve(staff("owner"), T0).ok).toBe(true);
    expect(limiter.reserve(visitor("a"), T0).ok).toBe(true);
    expect(limiter.reserve(visitor("b"), T0).ok).toBe(false);
  });

  it("gives the unit back when no event was created", () => {
    process.env.PUBLIC_BOOKING_MAX_PER_SESSION = "1";
    const limiter = createBookingLimiter();
    const first = limiter.reserve(visitor("a"), T0);
    expect(first.ok).toBe(true);
    if (first.ok) first.release();
    const second = limiter.reserve(visitor("a"), T0);
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
    // Releasing twice never drives a counter negative.
    if (second.ok) second.release();
    expect(limiter.reserve(visitor("a"), T0).ok).toBe(true);
  });

  it("a release after the day rolled over leaves no negative counter", () => {
    process.env.PUBLIC_BOOKING_DAILY_CAP = "1";
    const limiter = createBookingLimiter();
    const first = limiter.reserve(visitor("a"), T0);
    expect(first.ok).toBe(true);
    // Next day: the old counter was pruned, so a new visitor gets the budget.
    const nextDay = limiter.reserve(visitor("b"), NEXT_DAY);
    expect(nextDay.ok).toBe(true);
    // The first booking gives its unit back only now (its calendar call failed late).
    if (first.ok) first.release();
    expect(limiter.reserve(visitor("c"), NEXT_DAY).ok).toBe(false);
    if (nextDay.ok) nextDay.release();
    expect(limiter.reserve(visitor("c"), NEXT_DAY).ok).toBe(true);
  });

  it("reads caps from env and falls back to defaults on invalid values", () => {
    expect(readBookingLimits({})).toEqual({ sessionCap: 2, dailyCap: 8 });
    expect(readBookingLimits({ PUBLIC_BOOKING_MAX_PER_SESSION: "3", PUBLIC_BOOKING_DAILY_CAP: "25" })).toEqual({
      sessionCap: 3,
      dailyCap: 25,
    });
    expect(readBookingLimits({ PUBLIC_BOOKING_MAX_PER_SESSION: "0", PUBLIC_BOOKING_DAILY_CAP: "abc" })).toEqual({
      sessionCap: 2,
      dailyCap: 8,
    });
  });

  it("tells the model the appointment was never created", () => {
    for (const limit of ["session", "daily"] as const) {
      const message = bookingLimitMessage(limit, 2);
      expect(message).toContain("NO se creó");
      expect(message).toContain("register_lead");
      expect(message).not.toContain("undefined");
    }
  });
});
