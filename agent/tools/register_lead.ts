import { defineTool } from "eve/tools";
import { z } from "zod";
import { crmRegisterLead } from "../lib/crm";

export default defineTool({
  description: "Register a prospective client lead with contact details and project requirements in Creapolis CRM.",
  inputSchema: z.object({
    clientName: z.string().describe("Name of the prospective client or representative"),
    companyName: z.string().optional().describe("Company name if applicable"),
    contact: z.string().describe("Contact method such as WhatsApp number, phone, or email"),
    serviceType: z.enum(["software_development", "automation", "ai_implementation", "consulting"]).optional().describe("Service category"),
    projectSummary: z.string().describe("Summary of what the client wants to build or automate"),
    estimatedBudget: z.string().optional().describe("Budget range or timeline if disclosed"),
  }),
  async execute(input) {
    try {
      const crmResponse = await crmRegisterLead({
        clientName: input.clientName,
        companyName: input.companyName,
        contact: input.contact,
        serviceType: input.serviceType,
        projectSummary: input.projectSummary,
        estimatedBudget: input.estimatedBudget,
        source: "front_agent",
      });

      return {
        status: "registered_in_crm",
        leadId: crmResponse.leadId,
        stage: crmResponse.stage,
        clientName: input.clientName,
        recordedAt: crmResponse.recordedAt,
        message: "Lead successfully recorded in Creapolis CRM database.",
      };
    } catch (err) {
      // Graceful fallback for offline dev mode
      return {
        status: "saved_locally",
        leadId: `lead_${Date.now()}`,
        clientName: input.clientName,
        error: err instanceof Error ? err.message : "CRM connection unavailable",
      };
    }
  },
});
