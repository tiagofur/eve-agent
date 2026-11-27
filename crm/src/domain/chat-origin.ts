import { isNull, like, notLike, or, type SQL } from "drizzle-orm";
import { chatThreads } from "../db/schema";

/**
 * Where a chat thread comes from, read off its external key: the public chat
 * widget of creapolis.dev tags its threads "public:<uuid>", while everything
 * else — desktop chats, the Telegram orchestrator thread, schedule runs — is
 * internal staff traffic.
 */
export type ChatThreadOrigin = "web" | "internal";

export const WEB_THREAD_KEY_PREFIX = "public:";

export function chatThreadOrigin(externalKey: string | null): ChatThreadOrigin {
  return externalKey?.startsWith(WEB_THREAD_KEY_PREFIX) ? "web" : "internal";
}

export const webThreadFilter: SQL = like(
  chatThreads.externalKey,
  `${WEB_THREAD_KEY_PREFIX}%`
);

// NOT LIKE yields NULL (not true) on keyless threads, so those go in explicitly.
export const internalThreadFilter: SQL = or(
  isNull(chatThreads.externalKey),
  notLike(chatThreads.externalKey, `${WEB_THREAD_KEY_PREFIX}%`)
)!;
