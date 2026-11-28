import { describe, it, expect } from "vitest";
import { buildEventBody, createEventUrl, type ConsultationInput, type ResolvedSlot } from "../lib/google-calendar";

const SLOT: ResolvedSlot = {
  startRfc3339: "2030-01-15T10:00:00-06:00",
  endRfc3339: "2030-01-15T10:30:00-06:00",
  humanEs: "2030-01-15 10:00 (América/Costa_Rica)",
};

const INPUT: ConsultationInput = {
  clientName: "Ana Ruiz",
  contact: "ana.ruiz@ejemplo.com",
  discussionTopics: ["Automatización de leads", "Agente de WhatsApp"],
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
