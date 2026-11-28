import { defineTool } from "eve/tools";
import { z } from "zod";
import { listGmailMessages } from "../lib/google-gmail";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "List or search emails in the Creapolis.Dev Gmail inbox (creapolis.mx@gmail.com). " +
    "Supports standard Gmail search queries like 'is:unread', 'in:inbox', 'newer_than:2d', or 'from:client@example.com'. " +
    "Staff-only tool.",
  inputSchema: z.object({
    query: z
      .string()
      .default("in:inbox")
      .describe("Gmail search query (e.g. 'is:unread', 'in:inbox', 'newer_than:3d', 'from:foo@bar.com')"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(10)
      .describe("Maximum number of messages to return (1-25, default 10)"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "list_gmail_messages");
    try {
      return await listGmailMessages({
        query: input.query,
        maxResults: input.maxResults,
      });
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Error al listar correos de Gmail.",
      };
    }
  },
});
