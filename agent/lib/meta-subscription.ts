/**
 * Local-only Meta Muse subscription auth.
 *
 * Precedence mirrors the Muse Code CLI itself:
 *   1. META_API_KEY / MODEL_API_KEY (pay-as-you-go API billing) — always wins.
 *   2. Stored subscription credential (see credentialPath()), minted from the
 *      Muse Code subscription via a one-time OAuth device login. The
 *      short-lived Model API key is re-minted automatically (24h lifetime).
 *
 * The credential file is created by `node scripts/meta-login.mjs` (one-time
 * browser approval) and lives outside the repo, so it is never committed.
 * This path is LOCAL-ONLY by design: a deployment has no browser session to
 * refresh from, so production must set META_API_KEY instead.
 *
 * Mint flow replicates Pi's `/login meta` (device authorization against
 * auth.meta.com, key mint via POST https://api.meta.ai/muse-code/key).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLIENT_ID = "1031625952748946";
const API_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
const API_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface MetaSubscriptionCredential {
  type: "oauth";
  /** Long-lived identity token from the OAuth device flow. */
  refresh: string;
  /** Short-lived Model API key minted from the identity token. */
  access: string;
  /** Epoch ms when `access` expires and must be re-minted. */
  expires: number;
}

export class MetaSubscriptionExpiredError extends Error {
  constructor() {
    super("Meta subscription session expired. Sign in again with: node scripts/meta-login.mjs");
    this.name = "MetaSubscriptionExpiredError";
  }
}

export function credentialPath(): string {
  const dir =
    process.env.EVE_META_CREDENTIAL_DIR?.trim() ||
    join(homedir(), ".config", "eve-agent");
  return join(dir, "meta-subscription.json");
}

function isCredential(value: unknown): value is MetaSubscriptionCredential {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "oauth" &&
    typeof v.refresh === "string" &&
    v.refresh.length > 0 &&
    typeof v.access === "string" &&
    v.access.length > 0 &&
    typeof v.expires === "number" &&
    Number.isFinite(v.expires)
  );
}

export function readStoredCredential(): MetaSubscriptionCredential | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialPath(), "utf8"));
    return isCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredCredential(credential: MetaSubscriptionCredential): void {
  const path = credentialPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(credential, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems; the mode flag above already applied on write.
  }
}

export async function mintApiKey(identityToken: string): Promise<MetaSubscriptionCredential> {
  const response = await fetch(API_KEY_MINT_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${identityToken}`,
      "Content-Type": "application/json",
      "x-api-version": "1.0.0",
    },
    body: "{}",
  });
  if (response.status === 401 || response.status === 403) {
    throw new MetaSubscriptionExpiredError();
  }
  if (!response.ok) {
    throw new Error(
      `Meta API key mint failed (status ${response.status}). Retry later or sign in again with: node scripts/meta-login.mjs`
    );
  }
  const json: unknown = await response.json().catch(() => null);
  const apiKey = (json as { api_key?: unknown } | null)?.api_key;
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error(
      "Meta did not issue an API key. Check your Muse Code subscription, then sign in again with: node scripts/meta-login.mjs"
    );
  }
  return {
    type: "oauth",
    refresh: identityToken,
    access: apiKey,
    expires: Date.now() + API_KEY_LIFETIME_MS,
  };
}

let cachedCredential: MetaSubscriptionCredential | null | undefined;
let mintInFlight: Promise<string> | null = null;

export function resetSubscriptionCache(): void {
  cachedCredential = undefined;
  mintInFlight = null;
}

async function ensureAccessToken(): Promise<string> {
  if (cachedCredential === undefined) cachedCredential = readStoredCredential();
  if (cachedCredential && cachedCredential.expires - Date.now() > REFRESH_MARGIN_MS) {
    return cachedCredential.access;
  }
  const refreshToken = cachedCredential?.refresh ?? readStoredCredential()?.refresh;
  if (!refreshToken) {
    throw new Error(
      "Meta subscription auth not found. Sign in once with your Muse Code subscription: node scripts/meta-login.mjs (local-only, no API billing). Or set META_API_KEY for pay-as-you-go API billing."
    );
  }
  if (!mintInFlight) {
    mintInFlight = (async () => {
      try {
        const credential = await mintApiKey(refreshToken);
        cachedCredential = credential;
        writeStoredCredential(credential);
        return credential.access;
      } catch (error) {
        if (error instanceof MetaSubscriptionExpiredError) cachedCredential = null;
        throw error;
      } finally {
        mintInFlight = null;
      }
    })();
  }
  return mintInFlight;
}

/**
 * Fetch wrapper for the AI SDK provider that injects a fresh subscription
 * Model API key per request and retries once after re-minting on 401/403.
 */
export function createSubscriptionFetch(baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const requestWith = (apiKey: string): Promise<Response> => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${apiKey}`);
      return baseFetch(input, { ...init, headers });
    };
    let response = await requestWith(await ensureAccessToken());
    if (response.status === 401 || response.status === 403) {
      cachedCredential = null;
      mintInFlight = null;
      response = await requestWith(await ensureAccessToken());
    }
    return response;
  }) as typeof fetch;
}

export const __metaSubscriptionInternals = { CLIENT_ID };
