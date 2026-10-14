import { ensureDefaultApiKeys } from "./auth/keys";
import { pool } from "./db/client";

async function main() {
  const keys = await ensureDefaultApiKeys();
  console.log(JSON.stringify(keys));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
