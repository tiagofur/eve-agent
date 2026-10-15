import { describe, expect, it } from "vitest";
import {
  candidateDomains,
  discoverContact,
  extractEmails,
  extractPhones,
  normalizeDomain,
  slugifyCompany,
  type DiscoveryIO,
} from "./contact-discovery";

describe("normalizeDomain", () => {
  it("strips protocol, www, path, and query", () => {
    expect(normalizeDomain("https://www.Empresa.com/contacto?x=1")).toBe("empresa.com");
    expect(normalizeDomain("empresa.com.ar")).toBe("empresa.com.ar");
  });
});

describe("slugifyCompany", () => {
  it("removes accents and non-alphanumerics", () => {
    expect(slugifyCompany("Cocinas Ñandú S.R.L.")).toBe("cocinasnandusrl");
  });
});

describe("candidateDomains", () => {
  it("prefers an explicit domain hint", () => {
    expect(candidateDomains("Cualquier Nombre", "https://www.mi-empresa.com/")).toEqual(["mi-empresa.com"]);
  });

  it("guesses .com and .com.ar from the company name", () => {
    expect(candidateDomains("Muebles Díaz")).toEqual(["mueblesdiaz.com", "mueblesdiaz.com.ar"]);
  });
});

describe("extractEmails", () => {
  it("finds mailto links and plain-text emails, skipping junk", () => {
    const html = `
      <a href="mailto:info@empresa.com">Escríbenos</a>
      <p>Ventas: ventas@empresa.com, logo en logo@empresa.com.png</p>
      <p>Mail de prueba: test@empresa.com</p>`;
    expect(extractEmails(html)).toEqual(["info@empresa.com", "ventas@empresa.com"]);
  });
});

describe("extractPhones", () => {
  it("finds tel links and international numbers, skipping years", () => {
    const html = `
      <a href="tel:+5491123456789">Llamar</a>
      <p>Desde 1998 hacemos muebles. Tel: 011 4567-8901</p>`;
    const phones = extractPhones(html);
    expect(phones).toContain("+5491123456789");
    expect(phones.some((p) => p.includes("4567"))).toBe(true);
    expect(phones.some((p) => p.includes("1998"))).toBe(false);
  });
});

describe("discoverContact", () => {
  const fixtureHtml = `
    <html><body>
      <a href="mailto:contacto@acme.com">Contacto</a>
      <a href="tel:+541145678901">Tel</a>
      <a href="/contacto">Contacto</a>
    </body></html>`;

  function stubIO(pages: Record<string, string>, mx: boolean): DiscoveryIO {
    return {
      fetchText: async (url: string) => pages[url] ?? null,
      hasMx: async () => mx,
    };
  }

  it("returns page-confidence contacts observed on the site", async () => {
    const io = stubIO(
      {
        "https://acme.com": fixtureHtml,
        "https://acme.com/contacto": "<p>info@acme.com</p>",
      },
      true
    );
    const result = await discoverContact({ companyName: "ACME" }, io);
    expect(result.website).toBe("acme.com");
    expect(result.confidence).toBe("page");
    expect(result.verifiedEmails).toContain("contacto@acme.com");
    expect(result.verifiedEmails).toContain("info@acme.com");
    expect(result.verifiedPhones).toContain("+541145678901");
    expect(result.pagesChecked).toContain("https://acme.com/contacto");
  });

  it("falls back to an empty result when no candidate site responds", async () => {
    const result = await discoverContact({ companyName: "ACME" }, stubIO({}, false));
    expect(result).toMatchObject({ website: null, confidence: "none", verifiedEmails: [] });
  });

  it("marks domain confidence with suggestions when the site has no contacts but MX exists", async () => {
    const io = stubIO({ "https://acme.com": "<html><body>Sin contacto</body></html>" }, true);
    const result = await discoverContact({ companyName: "ACME" }, io);
    expect(result.confidence).toBe("domain");
    expect(result.verifiedEmails).toEqual([]);
    expect(result.suggestedEmails).toContain("info@acme.com");
    expect(result.domainHasMx).toBe(true);
  });
});
