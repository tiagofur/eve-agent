import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmLogInteraction } from "../lib/crm";

export default defineTool({
  description:
    "Log one entry in a client's unified thread in Creapolis CRM (inbound message received or outbound reply sent). Link it to whichever entity applies: lead, organization, ticket, project, or contact.",
  inputSchema: z.object({
    leadId: z.string().uuid().optional().describe("Lead UUID when the message belongs to a prospect"),
    organizationId: z.string().uuid().optional().describe("Organization UUID for existing clients"),
    ticketId: z.string().uuid().optional().describe("Ticket UUID when the message is about a ticket"),
    projectId: z.string().uuid().optional().describe("Project UUID when the message is about delivery"),
    contactId: z.string().uuid().optional().describe("Contact UUID of the person on the other end"),
    channel: z
      .enum(["whatsapp", "email", "telegram", "linkedin", "phone", "web", "other"])
      .describe("Channel where the message happened"),
    direction: z.enum(["inbound", "outbound"]).describe("inbound = client wrote; outbound = we replied"),
    content: z.string().min(1).max(4000).describe("Message text (verbatim when inbound, final reply when outbound)"),
  }),
  async execute(input) {
    try {
      const result = await crmLogInteraction({
        leadId: input.leadId,
        organizationId: input.organizationId,
        ticketId: input.ticketId,
        projectId: input.projectId,
        contactId: input.contactId,
        channel: input.channel,
        direction: input.direction,
        content: input.content,
      });

      return {
        status: "interaction_logged",
        interactionId: result.interaction.id,
        message: "Thread entry recorded in the unified client thread.",
      };
    } catch (err) {
      return {
        status: "log_failed",
        error: err instanceof Error ? err.message : "CRM API error",
      };
    }
  },
});
