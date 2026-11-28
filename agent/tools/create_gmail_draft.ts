import { defineTool } from "eve/tools";
import { z } from "zod";
import { createGmailDraft } from "../lib/google-gmail";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Create a Gmail draft in creapolis.mx@gmail.com (never sends automatically; the owner reviews and sends from Gmail). " +
    "Pass threadId and inReplyTo (Message-ID header) when drafting a reply inside an existing thread. Staff-only tool.",
  inputSchema: z.object({
    to: z.string().email().describe("Recipient email address"),
    subject: z.string().min(1).describe("Email subject line"),
    body: z.string().min(1).describe("Plain-text email body"),
    cc: z.string().optional().describe("Optional CC email address(es), comma-separated"),
    threadId: z
      .string()
      .optional()
      .describe("Optional Gmail threadId to attach this draft as a reply"),
    inReplyTo: z
      .string()
      .optional()
      .describe("Optional Message-ID header of the message being replied to"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "create_gmail_draft");
    try {
      return await createGmailDraft({
        to: input.to,
        subject: input.subject,
        body: input.body,
        cc: input.cc,
        threadId: input.threadId,
        inReplyTo: input.inReplyTo,
      });
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Error al crear el borrador en Gmail.",
      };
    }
  },
});
