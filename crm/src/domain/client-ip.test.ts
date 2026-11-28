import { describe, expect, it } from "vitest";
import { clientIp } from "./client-ip";

function headers(values: Record<string, string>) {
  return (name: string) => values[name.toLowerCase()];
}

describe("clientIp", () => {
  it("prefers X-Real-IP, which nginx overwrites with the TCP peer", () => {
    const ip = clientIp(headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" }));
    expect(ip).toBe("203.0.113.9");
  });

  it("keeps IPv6 addresses", () => {
    expect(clientIp(headers({ "x-real-ip": "2001:db8::5" }))).toBe("2001:db8::5");
    expect(clientIp(headers({ "x-forwarded-for": "2001:db8::5" }))).toBe("2001:db8::5");
  });

  it("takes the last X-Real-IP entry if a proxy ever appends to it", () => {
    expect(clientIp(headers({ "x-real-ip": "198.51.100.1, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores a spoofed first X-Forwarded-For entry when X-Real-IP is absent", () => {
    // $proxy_add_x_forwarded_for = what the client sent + the real peer.
    const ip = clientIp(
      headers({ "x-forwarded-for": "198.51.100.1, 198.51.100.2, 203.0.113.9" })
    );
    expect(ip).toBe("203.0.113.9");
  });

  it("a rotating fake header does not change the bucket", () => {
    const first = clientIp(headers({ "x-forwarded-for": `10.0.0.1, 203.0.113.9` }));
    const second = clientIp(headers({ "x-forwarded-for": `10.0.0.2, 203.0.113.9` }));
    expect(first).toBe(second);
  });

  it("falls back to a single forwarded entry and to loopback", () => {
    expect(clientIp(headers({ "x-forwarded-for": " 198.51.100.7 " }))).toBe("198.51.100.7");
    expect(clientIp(headers({ "x-real-ip": " ,", "x-forwarded-for": ", ," }))).toBe("127.0.0.1");
    expect(clientIp(headers({}))).toBe("127.0.0.1");
  });
});
