import type { ToolContext } from "eve/tools";

/**
 * Mechanical client-facing boundary for Creapolis Eve Agents.
 *
 * Route auth decides who the caller is (see docs: "Do not rely on model
 * behavior alone"). Public surfaces attach one of these principals:
 *
 *   - the CRM public-chat proxy, authenticating with the dedicated
 *     EVE_PUBLIC_USER basic credential (never the staff credential), or
 *   - a WhatsApp sender, via the chat-sdk channel's per-user auth.
 *
 * Everything else — the staff basic credential, Vercel OIDC, local dev, and
 * the null caller of internal sessions (schedules, delegated subagents) —
 * keeps full access.
 */

// Username of the CRM public-chat proxy credential. The agent only needs
// the username: it marks a principal as public, it does not verify it.
const PUBLIC_PROXY_USER = process.env.EVE_PUBLIC_USER?.trim() || "creapolis-public";

const PUBLIC_AUTHENTICATORS = new Set(["whatsapp"]);

export function isPublicCaller(ctx: ToolContext): boolean {
  const current = ctx.session.auth.current;
  if (!current) return false;
  if (PUBLIC_AUTHENTICATORS.has(current.authenticator)) return true;
  return (
    current.authenticator === "http-basic" && current.principalId === PUBLIC_PROXY_USER
  );
}

/**
 * Call first in every staff-only tool's execute. Throws a tool error the
 * model must answer with the polite public refusal; never returns for
 * public callers.
 */
export function requireStaff(ctx: ToolContext, toolName: string): void {
  if (!isPublicCaller(ctx)) return;
  const current = ctx.session.auth.current!;
  console.warn(
    JSON.stringify({
      event: "guard_denied",
      tool: toolName,
      authenticator: current.authenticator,
      principalId: current.principalId,
      sessionId: ctx.session.id,
    })
  );
  throw new Error(
    `${toolName} is restricted to Creapolis.Dev staff and is not available in public visitor sessions. ` +
      "Do not retry it. Politely explain that you can only help with Creapolis.Dev services, project consultations, scheduling, or support tickets."
  );
}
