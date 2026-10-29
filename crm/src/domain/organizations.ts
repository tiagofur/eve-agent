import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { organizations } from "../db/schema";

/** Clave de comparación de nombres: minúsculas, solo letras y números.
 *  "Creapolis.Dev" y "creapolis dev" caen en la misma clave ("creapolisdev"). */
export function normalizeOrgName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Resuelve una organización por nombre normalizado. Usar SIEMPRE al
 *  auto-crear orgs desde leads/tickets/dossiers: evita duplicados del tipo
 *  "Creapolis Dev" vs "Creapolis.Dev" que fragmentan la ficha 360. */
export async function findOrganizationByName(name: string) {
  const normalized = normalizeOrgName(name);
  if (!normalized) return undefined;
  const [org] = await db
    .select()
    .from(organizations)
    .where(
      sql`regexp_replace(LOWER(${organizations.name}), '[^a-z0-9]', '', 'g') = ${normalized}`
    )
    .limit(1);
  return org;
}
