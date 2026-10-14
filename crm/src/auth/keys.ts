import crypto from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { apiKeys, type apiScopeEnum } from "../db/schema";

export type ApiScope = (typeof apiScopeEnum.enumValues)[number];

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key.trim()).digest("hex");
}

export function generateRawApiKey(scope: ApiScope): string {
  const random = crypto.randomBytes(24).toString("hex");
  return `cp_${scope}_${random}`;
}

export async function verifyApiKey(rawKey: string): Promise<{
  valid: boolean;
  scope?: ApiScope;
  keyId?: string;
  name?: string;
}> {
  if (!rawKey || !rawKey.startsWith("cp_")) {
    return { valid: false };
  }

  const keyHash = hashApiKey(rawKey);

  const [found] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!found) {
    return { valid: false };
  }

  // Update lastUsedAt asynchronously
  db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, found.id))
    .catch(() => {});

  return {
    valid: true,
    scope: found.scope,
    keyId: found.id,
    name: found.name,
  };
}

export async function ensureDefaultApiKeys(): Promise<{
  frontKey: string | null;
  opsKey: string | null;
  ownerKey: string | null;
  devKey: string | null;
}> {
  // Check if any keys exist
  const existing = await db.select().from(apiKeys);
  const result: {
    frontKey: string | null;
    opsKey: string | null;
    ownerKey: string | null;
    devKey: string | null;
  } = {
    frontKey: null,
    opsKey: null,
    ownerKey: null,
    devKey: null,
  };

  const scopes: ApiScope[] = ["front", "ops", "owner", "dev"];

  for (const scope of scopes) {
    const hasKey = existing.some((k) => k.scope === scope && !k.revokedAt);
    if (!hasKey) {
      const raw = generateRawApiKey(scope);
      await db.insert(apiKeys).values({
        name: `Default ${scope} key`,
        scope,
        keyHash: hashApiKey(raw),
      });

      if (scope === "front") result.frontKey = raw;
      if (scope === "ops") result.opsKey = raw;
      if (scope === "owner") result.ownerKey = raw;
      if (scope === "dev") result.devKey = raw;
    }
  }

  return result;
}
