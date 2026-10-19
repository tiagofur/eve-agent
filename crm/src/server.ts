import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: "../.env.local" });
import { serve } from "@hono/node-server";
import { app } from "./app";
import { ensureDefaultApiKeys } from "./auth/keys";
import { startTelegramPolling } from "./services/telegram";
import { startFollowupDigest } from "./services/followup-digest";

const port = Number(process.env.PORT ?? 8787);

async function start() {
  const seeded = await ensureDefaultApiKeys();
  if (seeded.frontKey || seeded.opsKey || seeded.ownerKey) {
    console.log("-----------------------------------------");
    console.log("CRM Bootstrapped with new API keys:");
    if (seeded.frontKey) console.log(`FRONT_API_KEY=${seeded.frontKey}`);
    if (seeded.opsKey) console.log(`OPS_API_KEY=${seeded.opsKey}`);
    if (seeded.ownerKey) console.log(`OWNER_API_KEY=${seeded.ownerKey}`);
    if (seeded.devKey) console.log(`DEV_API_KEY=${seeded.devKey}`);
    console.log("-----------------------------------------");
  }

  serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`Creapolis CRM API running at http://localhost:${info.port}`);
      startTelegramPolling();
      startFollowupDigest();
    }
  );
}

start().catch((err) => {
  console.error("Failed to start CRM API:", err);
  process.exit(1);
});
