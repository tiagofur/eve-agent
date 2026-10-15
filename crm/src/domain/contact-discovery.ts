/**
 * Business contact discovery without paid APIs.
 *
 * Strategy, in order of reliability:
 *   1. Fetch the company's website (explicit domain, or slug guesses) and
 *      extract emails/phones observed on its pages ("page" confidence).
 *   2. If no contact is published but the domain accepts mail (MX records),
 *      return pattern-based suggestions ("domain" confidence) that a human
 *      must confirm before use. These are NEVER stored as verified contact.
 *   3. Otherwise report "none" so the caller stores the lead WITHOUT
 *      contact instead of fabricating a placeholder like contact@domain.
 */
import { promises as dns } from "node:dns";

export interface DiscoverContactInput {
  companyName: string;
  domain?: string;
}

export interface DiscoveredContact {
  website: string | null;
  verifiedEmails: string[];
  verifiedPhones: string[];
  /** Pattern-based guesses on an MX-valid domain. Unverified: human must confirm. */
  suggestedEmails: string[];
  domainHasMx: boolean;
  pagesChecked: string[];
  confidence: "page" | "domain" | "none";
}

export interface DiscoveryIO {
  fetchText(url: string): Promise<string | null>;
  hasMx(domain: string): Promise<boolean>;
}

const CONTACT_PATHS = ["", "/contacto", "/contact", "/contactanos", "/nosotros"];
const SUGGESTED_LOCAL_PARTS = ["info", "contacto", "contact", "hola", "ventas"];
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_CHARS = 500_000;

export function normalizeDomain(input: string): string {
  const cleaned = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const host = cleaned.split(/[\s/?#]/)[0] ?? "";
  return host;
}

export function slugifyCompany(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function candidateDomains(companyName: string, domainHint?: string): string[] {
  if (domainHint && domainHint.trim()) {
    const normalized = normalizeDomain(domainHint);
    return normalized ? [normalized] : [];
  }
  const slug = slugifyCompany(companyName);
  if (!slug) return [];
  return [`${slug}.com`, `${slug}.com.ar`];
}

const GENERIC_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Anchored, non-global: safe to use inside cleanEmail while a /g loop runs.
const EMAIL_VALID_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const MAILTO_RE = /mailto:([^\s"'<>?]+)/gi;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
const PRIORITY_LOCAL_PARTS = new Set([
  "info",
  "contacto",
  "contact",
  "contacto",
  "hola",
  "ventas",
  "sales",
  "admin",
  "hola",
]);

function cleanEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase().replace(/[.,;:!?)\]]+$/, "");
  if (!EMAIL_VALID_RE.test(email)) return null;
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return null;
  if (IMAGE_EXT_RE.test(email)) return null;
  if (domain.startsWith("example.") || domain === "example.com") return null;
  if (localPart.startsWith("test") || email.includes("sentry") || email.includes("wixpress")) return null;
  return email;
}

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  for (const re of [MAILTO_RE, GENERIC_EMAIL_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const cleaned = cleanEmail(match[1] ?? match[0] ?? "");
      if (cleaned) found.add(cleaned);
      if (found.size >= 50) break;
    }
  }
  const ranked = [...found].sort((a, b) => {
    const aLocal = a.split("@")[0] ?? "";
    const bLocal = b.split("@")[0] ?? "";
    const aScore = PRIORITY_LOCAL_PARTS.has(aLocal) ? 0 : 1;
    const bScore = PRIORITY_LOCAL_PARTS.has(bLocal) ? 0 : 1;
    return aScore - bScore;
  });
  return ranked;
}

const TEL_LINK_RE = /tel:([+\d][\d\s().-]{5,})/gi;
const PHONE_RE = /(\+\d[\d\s().-]{6,}\d|\b\d[\d\s().-]{7,}\d)/g;

function cleanPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  // Drop likely years/prices: bare digit runs without separators and short.
  if (!/[+\s().-]/.test(raw) && digits.length < 10) return null;
  return raw.trim().replace(/\s+/g, " ");
}

export function extractPhones(html: string): string[] {
  const found = new Map<string, string>();
  for (const re of [TEL_LINK_RE, PHONE_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const cleaned = cleanPhone(match[1] ?? match[0] ?? "");
      if (cleaned) {
        const key = cleaned.replace(/\D/g, "");
        if (!found.has(key)) found.set(key, cleaned);
      }
      if (found.size >= 30) break;
    }
  }
  return [...found.values()];
}

const defaultIO: DiscoveryIO = {
  async fetchText(url: string): Promise<string | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("text/html")) return null;
      const text = await response.text();
      return text.slice(0, MAX_HTML_CHARS);
    } catch {
      return null;
    }
  },
  async hasMx(domain: string): Promise<boolean> {
    try {
      const records = await dns.resolveMx(domain);
      return records.length > 0;
    } catch {
      return false;
    }
  },
};

export async function discoverContact(
  input: DiscoverContactInput,
  io: DiscoveryIO = defaultIO
): Promise<DiscoveredContact> {
  const empty: DiscoveredContact = {
    website: null,
    verifiedEmails: [],
    verifiedPhones: [],
    suggestedEmails: [],
    domainHasMx: false,
    pagesChecked: [],
    confidence: "none",
  };

  for (const domain of candidateDomains(input.companyName, input.domain)) {
    const homeUrl = `https://${domain}`;
    const home = await io.fetchText(homeUrl);
    if (home === null) continue;

    const pagesChecked = [homeUrl];
    const emails = new Set(extractEmails(home));
    const phones = new Map<string, string>();
    for (const phone of extractPhones(home)) {
      phones.set(phone.replace(/\D/g, ""), phone);
    }

    for (const path of CONTACT_PATHS.slice(1)) {
      if (emails.size >= 3 && phones.size >= 2) break;
      const url = `${homeUrl}${path}`;
      const html = await io.fetchText(url);
      if (html === null) continue;
      pagesChecked.push(url);
      for (const email of extractEmails(html)) emails.add(email);
      for (const phone of extractPhones(html)) {
        phones.set(phone.replace(/\D/g, ""), phone);
      }
    }

    const domainHasMx = await io.hasMx(domain);
    const verifiedEmails = [...emails].slice(0, 5);
    const verifiedSet = new Set(verifiedEmails);
    const suggestedEmails = domainHasMx
      ? SUGGESTED_LOCAL_PARTS.map((local) => `${local}@${domain}`).filter((e) => !verifiedSet.has(e))
      : [];

    return {
      website: domain,
      verifiedEmails,
      verifiedPhones: [...phones.values()].slice(0, 5),
      suggestedEmails,
      domainHasMx,
      pagesChecked,
      confidence: verifiedEmails.length > 0 ? "page" : domainHasMx ? "domain" : "none",
    };
  }

  return empty;
}
