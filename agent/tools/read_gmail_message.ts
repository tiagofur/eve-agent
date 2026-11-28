import { defineTool } from "eve/tools";
import { z } from "zod";
import { readGmailMessageOrThread } from "../lib/google-gmail";
import { requireStaff } from "../lib/guard";

export default defineTool({
  description:
    "Read the full content of an email message or an entire email thread from Creapolis.Dev Gmail (creapolis.mx@gmail.com). " +
    "Provide either messageId or threadId (obtained from list_gmail_messages). Staff-only tool.",
  inputSchema: z.object({
    messageId: z.string().optional().describe("Gmail message ID to read"),
    threadId: z
      .string()
      .optional()
      .describe("Gmail thread ID to read all messages in the conversation"),
  }),
  async execute(input, ctx) {
    requireStaff(ctx, "read_gmail_message");
    try {
      return await readGmailMessageOrThread({
        messageId: input.messageId,
        threadId: input.threadId,
      });
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Error al leer el correo de Gmail.",
      };
    }
  },
});
