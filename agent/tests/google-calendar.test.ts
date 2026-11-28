import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildEventBody,
  createEventUrl,
  scheduleConsultation,
  type ConsultationInput,
  type ResolvedSlot,
} from "../lib/google-calendar";

const SLOT: ResolvedSlot = {
  startRfc3339: "2030-01-15T10:00:00-06:00",
  endRfc3339: "2030-01-15T10:30:00-06:00",
  humanEs: "2030-01-15 10:00 (América/Costa_Rica)",
};

const INPUT: ConsultationInput = {
  clientName: "Ana Ruiz",
  contact: "ana.ruiz@ejemplo.com",
  discussionTopics: ["Automatización de leads", "Agente de WhatsApp"],
  invite: true,
};

describe("google-calendar event payloads", () => {
  it("the insert URL emails invitations only when invite is true", () => {
    expect(createEventUrl("cal-id", true)).toContain("sendUpdates=all");
    expect(createEventUrl("cal-id", false)).toContain("sendUpdates=none");
    expect(createEventUrl("cal-id", false)).not.toContain("sendUpdates=all");
    expect(createEventUrl("cal-id", false)).toContain("conferenceDataVersion=1");
    expect(createEventUrl("cal-id", false)).toContain(encodeURIComponent("cal-id"));
  });

  it("attaches the attendee only when one is passed", () => {
    const invited = buildEventBody(INPUT, SLOT, "ana.ruiz@ejemplo.com");
    expect(invited.attendees).toEqual([{ email: "ana.ruiz@ejemplo.com" }]);
    const silent = buildEventBody(INPUT, SLOT);
    expect("attendees" in silent).toBe(false);
  });

  it("keeps the contact in the description even without an invitation", () => {
    const body = buildEventBody(INPUT, SLOT);
    expect(body.description).toContain("Contacto: ana.ruiz@ejemplo.com");
    expect(body.description).toContain("Automatización de leads");
    expect(body.summary).toContain("Ana Ruiz");
    expect(body.start).toEqual({ dateTime: SLOT.startRfc3339, timeZone: "America/Costa_Rica" });
    expect(body.end).toEqual({ dateTime: SLOT.endRfc3339, timeZone: "America/Costa_Rica" });
    expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
  });

  it("builds a valid body for a booking with no usable email", () => {
    const body = buildEventBody({ ...INPUT, contact: "+5511999999999" }, SLOT);
    expect("attendees" in body).toBe(false);
    expect(body.description).toContain("Contacto: +5511999999999");
  });
});

describe("scheduleConsultation invitation behavior", () => {
  const ENV = { clientId: "cid", clientSecret: "sec", refreshToken: "rtok", calendarId: "qa@group.calendar.google.com" };
  const NOW = new Date("2030-01-10T15:00:00Z");
  let inserts: Array<{ url: string; body: any }> = [];

  /** Stub Google: token refresh, an empty freeBusy calendar, and event inserts. */
  function stubGoogle() {
    inserts = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "atok" }), { status: 200 });
      }
      if (u.includes("/freeBusy")) {
        return new Response(
          JSON.stringify({ calendars: { [ENV.calendarId]: { busy: [] } } }),
          { status: 200 }
        );
      }
      if (u.includes("/events?")) {
        inserts.push({ url: u, body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({ id: "evt-1", hangoutLink: "https://meet.google.com/qa-link", htmlLink: "https://calendar.google.com/qa-link" }),
          { status: 200 }
        );
      }
      throw new Error(`fetch inesperado: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const book = (over: Partial<Omit<ConsultationInput, "invite">> & { invite: boolean }) =>
    scheduleConsultation(
      {
        clientName: INPUT.clientName,
        contact: INPUT.contact,
        discussionTopics: INPUT.discussionTopics,
        preferredDate: "2030-06-15",
        preferredTimeSlot: "10:00 AM",
        now: NOW,
        ...over,
      },
      ENV
    );

  it("a public booking (invite:false) creates the event without attendee and marks the pending invite", async () => {
    stubGoogle();
    const res = await book({ invite: false });
    expect(res.status).toBe("scheduled");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].url).toContain("sendUpdates=none");
    expect("attendees" in inserts[0].body).toBe(false);
    expect(inserts[0].body.description).toContain("Contacto: ana.ruiz@ejemplo.com");
    expect(res.pendingInvite).toBe("ana.ruiz@ejemplo.com");
    expect(res.message).toContain("Invitación NO enviada automáticamente");
    expect(res.meetLink).toBe("https://meet.google.com/qa-link");
  });

  it("a staff booking (invite:true) attaches the attendee and reports the invitation", async () => {
    stubGoogle();
    const res = await book({ invite: true });
    expect(res.status).toBe("scheduled");
    expect(inserts[0].url).toContain("sendUpdates=all");
    expect(inserts[0].body.attendees).toEqual([{ email: "ana.ruiz@ejemplo.com" }]);
    expect(res.pendingInvite).toBeUndefined();
    expect(res.message).toContain("Invitación enviada a ana.ruiz@ejemplo.com");
  });

  it("without a usable email the event has no attendee and asks for manual follow-up", async () => {
    stubGoogle();
    const res = await book({ invite: false, contact: "+5511999999999" });
    expect(res.status).toBe("scheduled");
    expect("attendees" in inserts[0].body).toBe(false);
    expect(res.pendingInvite).toBeUndefined();
    expect(res.message).toContain("avísale manualmente");
  });
});
