import type { Context, Next } from "hono";
import { verifyApiKey, type ApiScope } from "../auth/keys";

export interface AuthContextVariables {
  apiKeyScope: ApiScope;
  apiKeyName: string;
  actor: string;
}

export function requireScope(allowedScopes: ApiScope[]) {
  return async (c: Context<{ Variables: AuthContextVariables }>, next: Next) => {
    const authHeader = c.req.header("Authorization") || c.req.header("x-api-key");
    if (!authHeader) {
      return c.json({ error: "Missing API key in Authorization or x-api-key header" }, 401);
    }

    const rawKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();
    const result = await verifyApiKey(rawKey);

    if (!result.valid || !result.scope) {
      return c.json({ error: "Invalid or revoked API key" }, 401);
    }

    // "owner" has superuser privileges across all scopes
    const hasPermission = result.scope === "owner" || allowedScopes.includes(result.scope);

    if (!hasPermission) {
      return c.json(
        {
          error: `Insufficient permissions. Key has scope '${result.scope}', required one of: ${allowedScopes.join(
            ", "
          )}`,
        },
        403
      );
    }

    c.set("apiKeyScope", result.scope);
    c.set("apiKeyName", result.name ?? "api_key");
    c.set("actor", `${result.scope}:${result.name ?? "unnamed"}`);

    await next();
  };
}
