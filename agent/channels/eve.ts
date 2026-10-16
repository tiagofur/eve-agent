import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

// Machine-to-machine access for the Creapolis CRM proxy. Credentials come
// from EVE_CHANNEL_USER / EVE_CHANNEL_PASSWORD at runtime (never committed);
// when unset, this entry is skipped and the walk falls through.
const channelUser = process.env.EVE_CHANNEL_USER;
const channelPassword = process.env.EVE_CHANNEL_PASSWORD;

export default eveChannel({
  auth: [
    ...(channelUser && channelPassword
      ? [httpBasic({ username: channelUser, password: channelPassword })]
      : []),
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev` and the REPL; ignored in production.
    localDev(),
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider, like Auth.js or Clerk,
    // or use none() for a public demo.
    placeholderAuth(),
  ],
});
