/**
 * Model-proof normalization + validation for research_and_save_prospect input.
 *
 * The orchestrator model sometimes invents parameter names instead of using
 * the exact schema keys. This module maps known aliases to the canonical
 * fields and fails LOUDLY (before any DB write) listing the exact names,
 * so the model can retry correctly within the same turn.
 */
export interface NormalizedResearchInput {
  companyName: string;
  contactEmail?: string;
  contactPhone?: string;
  domain?: string;
  summary: string;
  pains: string[];
  proposedSolution: string;
  sources: Array<{ url: string; note?: string }>;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedResearchInput }
  | { ok: false; error: string };

export function normalizeResearchInput(raw: unknown): NormalizeResult {
  const input =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const str = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = input[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };

  const rawList = (...names: string[]): unknown => {
    for (const name of names) {
      const value = input[name];
      if (Array.isArray(value)) return value;
      if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
  };

  const toStringList = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim());
    }
    if (typeof value === "string") {
      return value
        .split(/\n+/)
        .map((item) => item.replace(/^[-*•\d.)\s]+/, "").trim())
        .filter((item) => item.length > 0);
    }
    return [];
  };

  const companyName = str("companyName", "businessName", "business_name", "company", "empresa");
  const summary = str("summary", "dossier", "diagnosis", "resumen", "diagnostico");
  const proposedSolution = str(
    "proposedSolution",
    "opportunity",
    "solution",
    "solucion",
    "propuesta"
  );
  const pains = toStringList(rawList("pains", "operational_pains", "operationalPains", "dolores"));

  const sourcesRaw = rawList("sources", "source", "fuentes", "urls");
  const sources: Array<{ url: string; note?: string }> = [];
  const pushSource = (candidate: unknown): void => {
    if (typeof candidate === "string" && candidate.trim()) {
      sources.push({ url: candidate.trim() });
    } else if (candidate && typeof candidate === "object") {
      const url = (candidate as Record<string, unknown>).url;
      if (typeof url === "string" && url.trim()) sources.push({ url: url.trim() });
    }
  };
  if (Array.isArray(sourcesRaw)) {
    for (const item of sourcesRaw) pushSource(item);
  } else {
    pushSource(sourcesRaw);
  }

  const missing: string[] = [];
  if (!companyName) missing.push("companyName");
  if (!summary || summary.length < 20) missing.push("summary (texto de al menos 20 caracteres)");
  if (pains.length === 0) missing.push("pains (array con al menos 1 elemento)");
  if (!proposedSolution || proposedSolution.length < 20) {
    missing.push("proposedSolution (texto de al menos 20 caracteres)");
  }
  // sources is OPTIONAL: the orchestrator has no web-browsing tool, so it
  // cannot always cite verified URLs. Empty = unverified, human must confirm.

  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `Faltan campos requeridos con estos nombres EXACTOS: ${missing.join(", ")}. ` +
        `Recibido: ${Object.keys(input).join(", ") || "(vacío)"}. ` +
        `Reintenta la llamada usando esos nombres exactos.`,
    };
  }

  return {
    ok: true,
    value: {
      companyName: companyName as string,
      contactEmail: str("contactEmail", "email", "contact_email", "correo"),
      contactPhone: str("contactPhone", "phone", "contact_phone", "telefono"),
      domain: str("domain", "website", "site", "sitio"),
      summary: summary as string,
      pains,
      proposedSolution: proposedSolution as string,
      sources,
    },
  };
}
