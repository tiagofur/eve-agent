import { defineTool } from "eve/tools";
import { z } from "zod";
import { getUpcomingAppointments } from "../lib/google-calendar";

export default defineTool({
  description:
    "Retrieve upcoming consultation appointments and scheduled meetings from Creapolis.Dev Google Calendar. " +
    "Useful for checking the owner's schedule, pending client discovery calls, and meetings for the coming days.",
  inputSchema: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(7)
      .describe("Number of days ahead to search for appointments (default: 7)"),
  }),
  async execute(input) {
    try {
      const res = await getUpcomingAppointments(input.days);
      return res;
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : "Error al consultar Google Calendar.",
      };
    }
  },
});
