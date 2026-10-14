import "dotenv/config";
import { sql } from "drizzle-orm";
import { db } from "../db/client";

async function clean() {
  console.log("Cleaning automated test data from Creapolis CRM database...");

  // 1. Delete test tickets
  await db.execute(sql`
    DELETE FROM tickets 
    WHERE system = 'WhatsApp Order Bot'
  `);
  console.log("✓ Test tickets deleted ('WhatsApp Order Bot').");

  // 2. Delete test leads (Carlos Mendez, Valeria Gomez)
  await db.execute(sql`
    DELETE FROM outbox 
    WHERE lead_id IN (
      SELECT l.id FROM leads l
      JOIN contacts c ON l.contact_id = c.id
      WHERE c.name IN ('Carlos Mendez', 'Valeria Gomez')
    )
  `);

  await db.execute(sql`
    DELETE FROM leads 
    WHERE contact_id IN (
      SELECT id FROM contacts WHERE name IN ('Carlos Mendez', 'Valeria Gomez')
    )
  `);
  console.log("✓ Test leads deleted ('Carlos Mendez', 'Valeria Gomez').");

  // 3. Delete test contacts
  await db.execute(sql`
    DELETE FROM contacts 
    WHERE name IN ('Carlos Mendez', 'Valeria Gomez')
  `);
  console.log("✓ Test contacts deleted.");

  // 4. Delete test organizations
  await db.execute(sql`
    DELETE FROM organizations 
    WHERE name IN ('Acme Corp', 'Beta Ltd')
  `);
  console.log("✓ Test organizations deleted.");

  console.log("\nCleanup finished! Only real prospects (Dr. Carlos Mendoza) and API keys remain.");
}

clean().catch((err) => {
  console.error("Cleanup error:", err);
  process.exit(1);
});
