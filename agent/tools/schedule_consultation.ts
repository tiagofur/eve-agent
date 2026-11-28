import { defineTool } from "eve/tools";
import { z } from "zod";
import { bookingLimiter, bookingLimitMessage, isBookingLimited } from "../lib/booking-limits";
import { scheduleConsultation } from "../lib/google-calendar";

export default defineTool({
  description:
    "Schedule a REAL 30-minute discovery consultation on the Creapolis.Dev Google Calendar " +
    "(checks availability, creates the event with a Google Meet link). Staff sessions also email " +
    "the invitation to the contact; in visitor sessions the event is created WITHOUT an automatic " +
    "invitation — the team adds the guest from Calendar afterwards, so tell the visitor the team " +
    "will confirm to their email and never say the invitation was already sent. " +
    "Never invents slots: unknown dates, past times or busy calendars return an explicit message. " +
    "Visitor sessions have a small booking budget: a booking_limit_reached result means the " +
    "appointment was NOT created — do not retry or offer other slots; register the contact instead.",
  inputSchema: z.object({
    clientName: z.string().describe("Name of the prospective client"),
    contact: z.string().describe("Email or WhatsApp number to send the invitation to"),
    preferredDate: z.string().describe("Preferred date or day of the week (e.g. 2026-10-20, Next Monday morning)"),
    preferredTimeSlot: z.string().describe("Preferred time slot (e.g. 10:00 AM CST, afternoon)"),
    discussionTopics: z.array(z.string()).describe("List of topics to cover in the call"),
  }),
  async execute(input, ctx) {
    const permit = bookingLimiter.reserve(ctx);
    if (!permit.ok) {
      return {
        ok: false,
        status: "booking_limit_reached",
        limit: permit.limit,
        message: bookingLimitMessage(permit.limit, permit.cap),
      };
    }
    // Same public boundary as the booking caps: staff sessions keep the
    // automatic invitation; public, WhatsApp and unauthenticated ones never
    // email out of a request an anonymous visitor typed.
    const invite = !isBookingLimited(ctx);
    try {
      const result = await scheduleConsultation({
        clientName: input.clientName,
        contact: input.contact,
        discussionTopics: input.discussionTopics,
        preferredDate: input.preferredDate,
        preferredTimeSlot: input.preferredTimeSlot,
        invite,
      });
      if (result.status !== "scheduled") permit.release();
      return result;
    } catch (err) {
      permit.release();
      return {
        ok: false,
        status: "failed",
        message: err instanceof Error ? err.message : "No se pudo agendar la consulta.",
      };
    }
  },
});
