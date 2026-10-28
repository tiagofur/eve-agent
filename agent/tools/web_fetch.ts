import { defineTool } from "eve/tools";
import webFetch from "eve/tools/web_fetch";
import { requireStaff } from "../lib/guard";

// Staff-only wrapper around the built-in web_fetch: public visitor sessions
// must not turn the agent into an open fetcher/searcher for arbitrary URLs.
export default defineTool({
  ...webFetch,
  execute(input, ctx) {
    requireStaff(ctx, "web_fetch");
    return webFetch.execute(input, ctx);
  },
});
