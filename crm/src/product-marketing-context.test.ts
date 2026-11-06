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

  it("nunca devuelve docs tipo:pendiente", async () => {
    // heapdeck/solennix solo aparecen en _pendientes.md (tipo: pendiente) —
    // off-limits para marketing según docs/products/README.
    const ctx = await pickMarketingContext("heapdeck solennix ordo");
    expect(ctx).toBeNull();
  });

  it("devuelve null cuando ningún doc coincide (tema genérico)", async () => {
    const ctx = await pickMarketingContext("xyzzy temática inexistente qlkwjh");
    expect(ctx).toBeNull();
  });
});
