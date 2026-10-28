import type { CrmProjectItem } from "./crm";

/** Normalize for matching: lowercase, strip Spanish diacritics and non-alphanumerics. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();

/** Similarity score of a project against a user-provided name/description. */
export function scoreProject(p: CrmProjectItem, query: string): number {
  if (p.id.toLowerCase() === query.trim().toLowerCase()) return 100;
  const q = norm(query);
  if (!q) return 0;
  const name = norm(p.name);
  const org = norm(p.organizationName ?? "");
  if (name === q) return 100;
  if (org && org === q) return 80;
  if (name.startsWith(q) || q.startsWith(name)) return 60;
  if (name.includes(q) || q.includes(name)) return 40;
  if (org && (org.includes(q) || q.includes(org))) return 30;
  return 0;
}

/**
 * Best-effort resolution used where a mismatch must NOT block the operation
 * (e.g. linking a ticket to a project at intake): returns the unambiguous
 * match or null — the caller proceeds unlinked and says so.
 */
export function resolveProjectLoose(
  projects: CrmProjectItem[],
  query: string
): { project: CrmProjectItem; ambiguous: boolean } | null {
  const ranked = projects
    .map((project) => ({ project, score: scoreProject(project, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return null;
  const best = ranked[0]!;
  const ambiguous =
    ranked.length > 1 &&
    (best.score === ranked[1]!.score ||
      (ranked[1]!.score >= 30 && best.score - ranked[1]!.score < 20));
  return { project: best.project, ambiguous };
}
