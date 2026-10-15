import { describe, expect, it } from "vitest";
import { normalizeResearchInput } from "./research-input";

const COMPLETE = {
  companyName: "ACME",
  contactEmail: "info@acme.com",
  domain: "acme.com",
  summary: "Diagnóstico ejecutivo con más de veinte caracteres.",
  pains: ["No tiene reservas online"],
  proposedSolution: "Bot de reservas por WhatsApp con confirmación automática.",
  sources: [{ url: "https://acme.com" }],
};

describe("normalizeResearchInput", () => {
  it("accepts canonical input", () => {
    const result = normalizeResearchInput(COMPLETE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.companyName).toBe("ACME");
      expect(result.value.sources).toEqual([{ url: "https://acme.com" }]);
    }
  });

  it("maps the invented schema the model actually sends", () => {
    const result = normalizeResearchInput({
      companyName: "ACME",
      email: "",
      phone: "",
      website: "",
      dossier:
        "ACME - Dossier operativo: laboratorio clínico general con dolores de agendamiento manual y alto no-show.",
      operational_pains: ["Citas por teléfono manual", "Alto no-show sin recordatorios"],
      opportunity: "Sistema de reservas online con recordatorios automáticos por WhatsApp.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary.length).toBeGreaterThanOrEqual(20);
      expect(result.value.pains).toHaveLength(2);
      expect(result.value.proposedSolution.length).toBeGreaterThanOrEqual(20);
      expect(result.value.sources).toEqual([]);
    }
  });

  it("fails loudly listing exact names when required fields are missing", () => {
    const result = normalizeResearchInput({ companyName: "ACME" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("summary");
      expect(result.error).toContain("pains");
      expect(result.error).toContain("proposedSolution");
      expect(result.error).toContain("nombres EXACTOS");
    }
  });

  it("splits string pains and accepts string sources", () => {
    const result = normalizeResearchInput({
      ...COMPLETE,
      pains: "- Sin reservas online\n- No-show alto",
      sources: "https://acme.com/contacto",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pains).toEqual(["Sin reservas online", "No-show alto"]);
      expect(result.value.sources).toEqual([{ url: "https://acme.com/contacto" }]);
    }
  });

  it("rejects empty and non-object input", () => {
    expect(normalizeResearchInput({}).ok).toBe(false);
    expect(normalizeResearchInput(null).ok).toBe(false);
  });
});
