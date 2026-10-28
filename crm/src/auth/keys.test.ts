import { describe, expect, it, afterAll } from "vitest";
import { db } from "../db/client";
import { apiKeys } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import {
  hashApiKey,
  generateRawApiKey,
  verifyApiKey,
  ensureDefaultApiKeys,
} from "./keys";

describe("auth/keys unit tests", () => {
  const testHashes: string[] = [];

  afterAll(async () => {
    if (testHashes.length > 0) {
      await db.delete(apiKeys).where(inArray(apiKeys.keyHash, testHashes));
    }
  });

  it("generateRawApiKey creates keys with cp_<scope>_ prefix and random hex", () => {
    const raw = generateRawApiKey("ops");
    expect(raw).toMatch(/^cp_ops_[0-9a-f]{48}$/);
  });

  it("hashApiKey produces deterministic SHA-256", () => {
    const key = "cp_ops_1234567890abcdef";
    const h1 = hashApiKey(key);
    const h2 = hashApiKey(`  ${key}  `);
    expect(h1).toHaveLength(64);
    expect(h1).toBe(h2);
  });

  it("verifyApiKey rejects non-cp_ or empty keys", async () => {
    expect((await verifyApiKey("")).valid).toBe(false);
    expect((await verifyApiKey("invalid_prefix")).valid).toBe(false);
    expect((await verifyApiKey("bearer_token")).valid).toBe(false);
  });

  it("verifyApiKey validates active key and rejects revoked key", async () => {
    const raw = generateRawApiKey("front");
    const hash = hashApiKey(raw);
    testHashes.push(hash);

    const [inserted] = await db
      .insert(apiKeys)
      .values({
        name: "Test Verification Key",
        scope: "front",
        keyHash: hash,
      })
      .returning();

    const check1 = await verifyApiKey(raw);
    expect(check1.valid).toBe(true);
    expect(check1.scope).toBe("front");

    // Revoke key
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, inserted!.id));

    const check2 = await verifyApiKey(raw);
    expect(check2.valid).toBe(false);
  });

  it("ensureDefaultApiKeys un-revokes key if explicitly provided via env", async () => {
    const envKey = generateRawApiKey("dev");
    const envHash = hashApiKey(envKey);
    testHashes.push(envHash);

    // Insert key as revoked
    const [inserted] = await db
      .insert(apiKeys)
      .values({
        name: "Previously Revoked Dev Key",
        scope: "dev",
        keyHash: envHash,
        revokedAt: new Date(),
      })
      .returning();

    process.env.DEV_API_KEY = envKey;
    try {
      await ensureDefaultApiKeys();
      const [refreshed] = await db.select().from(apiKeys).where(eq(apiKeys.id, inserted!.id));
      expect(refreshed?.revokedAt).toBeNull();
      expect(refreshed?.name).toBe("Env dev key");

      // Verification should now succeed
      const check = await verifyApiKey(envKey);
      expect(check.valid).toBe(true);
    } finally {
      delete process.env.DEV_API_KEY;
    }
  });
});
