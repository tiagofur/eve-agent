#!/usr/bin/env node
/**
 * One-time Meta Muse subscription login for local eve agent runs.
 *
 * Replicates Pi's `/login meta` device flow (same public OAuth client):
 *   1. Requests a device code from https://auth.meta.com.
 *   2. You approve it once in the browser (uses your Muse Code subscription).
 *   3. Exchanges the approved session for an identity token.
 *   4. Mints a Model API key and stores it (with the identity token) at
 *      ~/.config/eve-agent/meta-subscription.json (mode 0600).
 *
 * The agent (`agent/lib/models.ts`) reuses that file and re-mints the
 * short-lived key automatically. Nothing is committed to the repo.
 * LOCAL-ONLY: never copy this file to a server; deployments use META_API_KEY.
 *
 * Usage:
 *   node scripts/meta-login.mjs          # sign in (opens browser approval)
 *   node scripts/meta-login.mjs --check  # show stored credential status
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLIENT_ID = "1031625952748946";
const DEVICE_AUTHORIZATION_URL = "https://auth.meta.com/oidc/device/authorization/";
const DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const API_KEY_MINT_URL = "https://api.meta.ai/muse-code/key";
const API_KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

function credentialPath() {
  const dir = process.env.EVE_META_CREDENTIAL_DIR?.trim() || join(homedir(), ".config", "eve-agent");
  return join(dir, "meta-subscription.json");
}

function readStored() {
  try {
    const parsed = JSON.parse(readFileSync(credentialPath(), "utf8"));
    if (
      parsed?.type === "oauth" &&
      typeof parsed.refresh === "string" &&
      typeof parsed.access === "string" &&
      typeof parsed.expires === "number"
    ) {
      return parsed;
    }
  } catch {
    // No usable credential yet.
  }
  return null;
}

async function postForm(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => null);
  return { response, json };
}

function describeExpiry(expires) {
  const ms = expires - Date.now();
  if (ms <= 0) return "expirada";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `válida por ~${h}h ${m}m` : `válida por ~${m}m`;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Uso:
  node scripts/meta-login.mjs          Inicia sesión con tu suscripción de Muse Code
  node scripts/meta-login.mjs --check  Muestra el estado de la credencial guardada

La credencial se guarda en ${credentialPath()} (solo local, nunca se commitea).`);
  process.exit(0);
}

if (process.argv.includes("--check")) {
  const stored = readStored();
  if (!stored) {
    console.log(`Sin credencial en ${credentialPath()}\nInicia sesión con: node scripts/meta-login.mjs`);
    process.exit(1);
  }
  console.log(`Credencial de suscripción: ${describeExpiry(stored.expires)} (clave de corta duración).`);
  console.log("El agente la renueva solo; si expiró la sesión, corre de nuevo: node scripts/meta-login.mjs");
  process.exit(0);
}

if (process.env.META_API_KEY || process.env.MODEL_API_KEY) {
  console.log("Aviso: tienes META_API_KEY/MODEL_API_KEY definido; esa clave por API tiene prioridad sobre la suscripción.");
}

const { response: authRes, json: authJson } = await postForm(DEVICE_AUTHORIZATION_URL, {
  client_id: CLIENT_ID,
});
if (!authRes.ok || typeof authJson?.device_code !== "string" || typeof authJson?.user_code !== "string") {
  console.error(`No se pudo iniciar el login (status ${authRes.status}). Revisa tu conexión e inténtalo de nuevo.`);
  process.exit(1);
}

const verificationUri =
  authJson.verification_uri_complete || authJson.verification_uri || "https://auth.meta.com";
const intervalMs = Math.max(5000, (Number(authJson.interval) || 5) * 1000);
const deadline = Date.now() + (Number(authJson.expires_in) || 600) * 1000;

console.log(`\n1. Abre en tu navegador:\n   ${verificationUri}\n2. Ingresa el código: ${authJson.user_code}\n\nEsperando aprobación (Ctrl+C para cancelar)…`);

let identityToken = null;
let pollIntervalMs = intervalMs;
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  const { response, json } = await postForm(DEVICE_TOKEN_URL, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: authJson.device_code,
    client_id: CLIENT_ID,
  });
  if (response.ok && typeof json?.access_token === "string" && json.access_token) {
    identityToken = json.access_token;
    break;
  }
  if (json?.error === "authorization_pending") continue;
  if (json?.error === "slow_down") {
    pollIntervalMs += 5000;
    continue;
  }
  if (json?.error === "access_denied") {
    console.error("Login denegado en el navegador. Corre el script de nuevo si fue un error.");
    process.exit(1);
  }
  if (json?.error === "expired_token") {
    console.error("El código expiró. Corre el script de nuevo para generar otro.");
    process.exit(1);
  }
  console.error(`Fallo el login (status ${response.status}). Corre el script de nuevo.`);
  process.exit(1);
}
if (!identityToken) {
  console.error("Se acabó el tiempo de espera. Corre el script de nuevo.");
  process.exit(1);
}

console.log("Aprobado. Habilitando acceso al Model API…");
const mintRes = await fetch(API_KEY_MINT_URL, {
  method: "POST",
  headers: {
    Accept: "application/json",
    Authorization: `Bearer ${identityToken}`,
    "Content-Type": "application/json",
    "x-api-version": "1.0.0",
  },
  body: "{}",
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
const mintJson = await mintRes.json().catch(() => null);
if ((mintRes.status === 401 || mintRes.status === 403) && mintJson?.action_url) {
  console.error(`Meta pide completar la configuración en: ${mintJson.action_url}\nCompleta ese paso y corre el script de nuevo.`);
  process.exit(1);
}
if (!mintRes.ok || typeof mintJson?.api_key !== "string" || !mintJson.api_key) {
  console.error(`Meta no emitió una clave (status ${mintRes.status}). Verifica tu suscripción de Muse Code e inténtalo de nuevo.`);
  process.exit(1);
}

const path = credentialPath();
mkdirSync(dirname(path), { recursive: true });
writeFileSync(
  path,
  JSON.stringify({ type: "oauth", refresh: identityToken, access: mintJson.api_key, expires: Date.now() + API_KEY_LIFETIME_MS }, null, 2) + "\n",
  { mode: 0o600 }
);
try {
  chmodSync(path, 0o600);
} catch {
  // Best effort en filesystems no-POSIX.
}

const needsUnset = process.env.META_API_KEY || process.env.MODEL_API_KEY;
console.log(`\nListo. Credencial guardada en ${path}\nTu agente usará la suscripción (sin costo por API). La clave se renueva sola cada 24h.`);
if (needsUnset) {
  console.log("Recuerda: quita META_API_KEY/MODEL_API_KEY del entorno para que la suscripción tenga efecto (la clave por API siempre gana).");
}
if (!existsSync(path)) {
  console.error("No se pudo verificar el archivo de credencial.");
  process.exit(1);
}
