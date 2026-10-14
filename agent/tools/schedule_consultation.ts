import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Schedule a 30-minute discovery and technical architecture consultation with the Creapolis.Dev engineering team.",
  inputSchema: z.object({
    clientName: z.string().describe("Name of the prospective client"),
    contact: z.string().describe("Email or WhatsApp number to send the invitation to"),
    preferredDate: z.string().describe("Preferred date or day of the week (e.g. 2026-10-20, Next Monday morning)"),
    preferredTimeSlot: z.string().describe("Preferred time slot (e.g. 10:00 AM CST, afternoon)"),
    discussionTopics: z.array(z.string()).describe("List of topics to cover in the call"),
  }),
  async execute(input) {
    return {
      status: "consultation_scheduled",
      confirmationCode: `CONF-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
      meetingLink: "https://meet.creapolis.dev/discovery",
      scheduledAt: new Date().toISOString(),
      ...input,
    };
  },
});
