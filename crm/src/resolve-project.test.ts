import { describe, expect, it } from "vitest";
import { norm, scoreProject, resolveProjectLoose } from "../../agent/lib/project-match";
import type { CrmProjectItem } from "../../agent/lib/crm";

describe("resolve_project scoring and normalization", () => {
  const dummyProject: CrmProjectItem = {
    id: "0d451dd6-4c90-4c69-b41e-48d596e7cd77",
    name: "eve-agent",
    status: "active",
    repoUrl: "https://github.com/tiagofur/eve-agent",
    localPath: "/Users/tiagofur/workspace/eve-agent",
    defaultBranch: "main",
    testCommand: "npm test",
    organizationName: "Creapolis.Dev - Interno",
    createdAt: new Date().toISOString(),
  };

  it("normalizes accents and special characters cleanly", () => {
    expect(norm("Corrección")).toBe("correccion");
    expect(norm("Creápolis.Dev — Interno")).toBe("creapolisdevinterno");
    expect(norm("  eve-agent!  ")).toBe("eveagent");
  });

  it("scores 100 on exact UUID query", () => {
    expect(scoreProject(dummyProject, "0d451dd6-4c90-4c69-b41e-48d596e7cd77")).toBe(100);
    expect(scoreProject(dummyProject, "0D451DD6-4C90-4C69-B41E-48D596E7CD77")).toBe(100);
  });

  it("scores 100 on exact project name match (ignoring case & punctuation)", () => {
    expect(scoreProject(dummyProject, "eve-agent")).toBe(100);
    expect(scoreProject(dummyProject, "Eve Agent")).toBe(100);
    expect(scoreProject(dummyProject, "EVE_AGENT")).toBe(100);
  });

  it("scores 80 on organization exact match", () => {
    expect(scoreProject(dummyProject, "Creapolis Dev Interno")).toBe(80);
  });

  it("scores partial matches and prefix matches appropriately", () => {
    expect(scoreProject(dummyProject, "eve")).toBe(60);
    expect(scoreProject(dummyProject, "agent")).toBe(40);
  });

  it("returns 0 for completely unrelated queries", () => {
    expect(scoreProject(dummyProject, "unrelated-crypto-bot")).toBe(0);
  });
});

describe("resolveProjectLoose (ticket intake auto-link)", () => {
  const projects: CrmProjectItem[] = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Portal Web Pagos",
      status: "active",
      repoUrl: null,
      localPath: null,
      defaultBranch: "main",
      testCommand: null,
      organizationName: "Cliente A",
      createdAt: new Date().toISOString(),
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      name: "Portal Web Clientes",
      status: "active",
      repoUrl: null,
      localPath: null,
      defaultBranch: "main",
      testCommand: null,
      organizationName: "Cliente B",
      createdAt: new Date().toISOString(),
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      name: "eve-agent",
      status: "onboarding",
      repoUrl: null,
      localPath: null,
      defaultBranch: "main",
      testCommand: null,
      organizationName: "Creapolis.Dev — Interno",
      createdAt: new Date().toISOString(),
    },
  ];

  it("resolves a unique match and never blocks on mismatch", () => {
    expect(resolveProjectLoose(projects, "eve agent")?.project.id).toBe(
      "33333333-3333-3333-3333-333333333333"
    );
    expect(resolveProjectLoose(projects, "noexiste")).toBeNull();
  });

  it("flags ambiguity instead of silently picking a tie", () => {
    const result = resolveProjectLoose(projects, "Portal Web");
    expect(result?.ambiguous).toBe(true);
  });
});
