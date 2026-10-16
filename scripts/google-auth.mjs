#!/usr/bin/env node
/**
 * One-time Google Calendar consent for the Creapolis.Dev eve agent.
 *
 * Uses a Desktop-app OAuth client with loopback redirect (any 127.0.0.1 port
 * is allowed without pre-registration):
 *   1. Starts a localhost server and prints the consent URL (offline access
 *      + calendar scope, prompt=consent so Google issues a refresh token).
 *   2. You approve once in the browser.
 *   3. Exchanges the code and stores { refresh_token } at
 *      ~/.config/eve-agent/google-calendar.json (mode 0600).
 *
 * The agent (`agent/lib/google-calendar.ts`) refreshes short-lived access
 * tokens from it automatically. Nothing is committed to the repo.
 * LOCAL-ONLY: never copy this file's output to a server; deployments set
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN as env vars.
 *
 * Setup (once): Google Cloud → enable Calendar API → OAuth consent (External,
 * test mode, add yourself as test user) → Credentials → OAuth client ID of
 * type "Desktop app".
 *
 * Usage:
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-auth.mjs
 *   node scripts/google-auth.mjs --check    # show stored credential status
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

const SCOPE = "https://www.googleapis.com/auth/calendar";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;

function credentialPath() {
  const dir =
    process.env.EVE_GOOGLE_CREDENTIAL_DIR?.trim() || join(homedir(), ".config", "eve-agent");
  return join(dir, "google-calendar.json");
}

function readStored() {
  try {
    const parsed = JSON.parse(readFileSync(credentialPath(), "utf8"));
    if (
      parsed?.type === "oauth" &&
      parsed?.provider === "google-calendar" &&
      typeof parsed.refresh_token === "string" &&
      typeof parsed.obtained_at === "string"
    ) {
      return parsed;
    }
  } catch {
    // No usable credential yet.
  }
  return null;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Uso:
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google-auth.mjs
  node scripts/google-auth.mjs --check    Muestra el estado de la credencial guardada

La credencial se guarda en ${credentialPath()} (solo local, nunca se commitea).`);
  process.exit(0);
}

if (process.argv.includes("--check")) {
  const stored = readStored();
  if (!stored) {
    console.log("Sin credencial de Google Calendar. Corre el flujo completo para crearla.");
    process.exit(1);
  }
  console.log(`Credencial Google Calendar presente (obtenida: ${stored.obtained_at}).`);
  process.exit(0);
}

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error(
    "Faltan GOOGLE_CLIENT_ID y/o GOOGLE_CLIENT_SECRET en el entorno.\n" +
      "Créalas en Google Cloud (APIs & Services → Credentials → OAuth client ID, tipo Desktop app) " +
      "y reintenta."
  );
  process.exit(1);
}

const server = createServer();
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  console.log("Abre esta URL en tu navegador y aprueba el acceso:\n");
  console.log(`${AUTH_URL}?${params.toString()}\n`);
  console.log("Esperando aprobación (5 minutos)...");

  const timer = setTimeout(() => {
    console.error("Tiempo agotado esperando aprobación. Reintenta.");
    server.close();
    process.exit(1);
  }, CALLBACK_TIMEOUT_MS);

  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    if (!code) {
      res.end("Acceso denegado o incompleto. Puedes cerrar esta ventana y reintentar.");
      clearTimeout(timer);
      console.error(`Google respondió sin código (${error ?? "desconocido"}).`);
      server.close();
      process.exit(1);
      return;
    }
    res.end("Acceso aprobado. Puedes cerrar esta ventana y volver a la terminal.");
    clearTimeout(timer);
    server.close();

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const tokens = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokens || typeof tokens.refresh_token !== "string") {
      console.error(
        `Intercambio de código falló (HTTP ${tokenRes.status}). Revisa cliente/secreto y reintenta.`
      );
      process.exit(1);
    }
    mkdirSync(dirname(credentialPath()), { recursive: true });
    writeFileSync(
      credentialPath(),
      JSON.stringify(
        {
          type: "oauth",
          provider: "google-calendar",
          client_id: clientId,
          refresh_token: tokens.refresh_token,
          obtained_at: new Date().toISOString(),
        },
        null,
        2
      )
    );
    chmodSync(credentialPath(), 0o600);
    console.log(`\nListo. Refresh token guardado en ${credentialPath()} (modo 0600).`);
    console.log(
      "Para el servicio, configura GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y " +
        "GOOGLE_REFRESH_TOKEN (el guardado) en el .env. Opcional: GOOGLE_CALENDAR_ID."
    );
  });
});
