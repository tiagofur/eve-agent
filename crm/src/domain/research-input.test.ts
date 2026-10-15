import { describe, expect, it } from "vitest";
import { normalizeResearchInput } from "./research-input";

const COMPLETE = {
  companyName: "ACME",
  contactEmail: "info@acme.com",
  domain: "acme.com",
  summary: "Diagnóstico ejecutivo con más de veinte caracteres.",
  pains: ["No tiene reservas online"],
  techStack: ["WordPress"],
  proposedSolution: "Bot de reservas por WhatsApp con confirmación automática.",
  outreachAngle: "Felicitar por su reputación y proponer atención 24/7 con IA.",
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
      angle: "Empatizar con la saturación de recepción y proponer una recepcionista digital 24/7.",
      stack: "WordPress, WhatsApp manual",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary.length).toBeGreaterThanOrEqual(20);
      expect(result.value.pains).toHaveLength(2);
      expect(result.value.proposedSolution.length).toBeGreaterThanOrEqual(20);
      expect(result.value.outreachAngle.length).toBeGreaterThanOrEqual(20);
      expect(result.value.techStack).toEqual(["WordPress", "WhatsApp manual"]);
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
      expect(result.error).toContain("outreachAngle");
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

  it("allows an empty techStack when the business has no web presence", () => {
    const { techStack, ...withoutStack } = COMPLETE;
    const result = normalizeResearchInput(withoutStack);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(techStack).toBeDefined(); // guard: COMPLETE carries a stack for other tests
      expect(result.value.techStack).toEqual([]);
    }
  });

  it("rejects a short outreach angle", () => {
    const result = normalizeResearchInput({ ...COMPLETE, outreachAngle: "hola" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("outreachAngle");
    }
  });

  it("rejects empty and non-object input", () => {
    expect(normalizeResearchInput({}).ok).toBe(false);
    expect(normalizeResearchInput(null).ok).toBe(false);
  });
});
