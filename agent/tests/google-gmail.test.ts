import { describe, it, expect, afterEach } from "vitest";
import {
  buildRawMimeMessage,
  extractBodyFromPayload,
  listGmailMessages,
  readGmailEnv,
} from "../lib/google-gmail";

function decodeBase64Url(encoded: string): string {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function encodeBase64Url(text: string): string {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

describe("google-gmail", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("readGmailEnv returns null when credentials are missing", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REFRESH_TOKEN;
    expect(readGmailEnv()).toBeNull();
  });

  it("readGmailEnv reads trimmed credentials when set", () => {
    process.env.GOOGLE_CLIENT_ID = " client-id ";
    process.env.GOOGLE_CLIENT_SECRET = " client-secret ";
    process.env.GOOGLE_REFRESH_TOKEN = " refresh-token ";
    expect(readGmailEnv()).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
  });

  it("listGmailMessages returns setup hint when env is not configured", async () => {
    const res = await listGmailMessages({}, null);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("scripts/google-auth.mjs");
  });

  it("extractBodyFromPayload prefers text/plain over text/html", () => {
    const body = extractBodyFromPayload({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: encodeBase64Url("Hola Tiago") } },
        { mimeType: "text/html", body: { data: encodeBase64Url("<p>Hola <b>HTML</b></p>") } },
      ],
    });
    expect(body).toBe("Hola Tiago");
  });

  it("extractBodyFromPayload strips HTML when only text/html exists", () => {
    const body = extractBodyFromPayload({
      mimeType: "text/html",
      body: { data: encodeBase64Url("<p>Hola&nbsp;<b>mundo</b></p><script>bad()</script>") },
    });
    expect(body).toBe("Hola mundo");
  });

  it("buildRawMimeMessage encodes headers, reply references, and UTF-8 subjects", () => {
    const raw = buildRawMimeMessage({
      to: "cliente@ejemplo.com",
      cc: "equipo@creapolis.dev",
      subject: "Cotización proyecto",
      body: "Hola, adjunto el resumen.",
      inReplyTo: "<msg-123@mail.gmail.com>",
    });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("To: cliente@ejemplo.com");
    expect(decoded).toContain("Cc: equipo@creapolis.dev");
    expect(decoded).toContain("Subject: =?UTF-8?B?");
    expect(decoded).toContain("In-Reply-To: <msg-123@mail.gmail.com>");
    expect(decoded).toContain("References: <msg-123@mail.gmail.com>");
    expect(decoded).toContain("Hola, adjunto el resumen.");
  });
});
