import { defineTool } from "eve/tools";
import { z } from "zod";
import { scheduleConsultation } from "../lib/google-calendar";

export default defineTool({
  description:
    "Schedule a REAL 30-minute discovery consultation on the Creapolis.Dev Google Calendar " +
    "(checks availability, creates the event with a Google Meet link, invites the contact email). " +
    "Never invents slots: unknown dates, past times or busy calendars return an explicit message.",
  inputSchema: z.object({
    clientName: z.string().describe("Name of the prospective client"),
    contact: z.string().describe("Email or WhatsApp number to send the invitation to"),
    preferredDate: z.string().describe("Preferred date or day of the week (e.g. 2026-10-20, Next Monday morning)"),
    preferredTimeSlot: z.string().describe("Preferred time slot (e.g. 10:00 AM CST, afternoon)"),
    discussionTopics: z.array(z.string()).describe("List of topics to cover in the call"),
  }),
  async execute(input) {
    try {
      return await scheduleConsultation({
        clientName: input.clientName,
        contact: input.contact,
        discussionTopics: input.discussionTopics,
        preferredDate: input.preferredDate,
        preferredTimeSlot: input.preferredTimeSlot,
      });
    } catch (err) {
      return {
        ok: false,
        status: "failed",
        message: err instanceof Error ? err.message : "No se pudo agendar la consulta.",
      };
    }
  },
});
