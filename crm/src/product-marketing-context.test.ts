import { describe, expect, it } from "vitest";
import { pickMarketingContext } from "./domain/products";

// The marketing generation grounds posts in docs/products/*.md. These tests
// run against the real docs in the repo (same source the API serves).
describe("pickMarketingContext (grounding de marketing en docs de productos)", () => {
  it("detecta pepinillo desde un tema corto y devuelve la ficha completa", async () => {
    const ctx = await pickMarketingContext("pepinillo deep work pomodoro");
    expect(ctx).not.toBeNull();
    expect(ctx?.slug).toBe("pepinillo");
    expect(ctx?.markdown).toContain("## Ángulos de marketing");
    expect(ctx?.markdown).toContain("4 modos");
  });

  it("detecta algún doc de producto para un tema de servicios", async () => {
    const ctx = await pickMarketingContext("automatizar procesos con agentes de IA");
    expect(ctx).not.toBeNull();
    expect(ctx?.markdown).toContain("## Ángulos de marketing");
  });

  it("nunca devuelve docs tipo:pendiente (y solennix ya es pública)", async () => {
    // heapdeck/ordo siguen solo en _pendientes.md (tipo: pendiente) —
    // off-limits para marketing según docs/products/README. Solennix tiene
    // ficha propia desde 2026-11-11, así que ya debe ser detectable.
    const ctx = await pickMarketingContext("heapdeck ordo");
    expect(ctx).toBeNull();

    const solennix = await pickMarketingContext("solennix eventos cotizaciones");
    expect(solennix?.slug).toBe("solennix");
    expect(solennix?.markdown).toContain("## Ángulos de marketing");
  });

  it("devuelve null cuando ningún doc coincide (tema genérico)", async () => {
    const ctx = await pickMarketingContext("xyzzy temática inexistente qlkwjh");
    expect(ctx).toBeNull();
  });
});
