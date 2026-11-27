import { and, isNull, like, notLike, or, type SQL } from "drizzle-orm";
import { chatThreads } from "../db/schema";

/**
 * Where a chat thread comes from, read off its external key: the public chat
 * widget of creapolis.dev tags its threads "public:<uuid>", while everything
 * else — desktop chats, the Telegram orchestrator thread — is internal staff
 * traffic. Schedule runs tag theirs "schedule:<scheduleId>:<ms>" so the
 * owner's chat list can leave them out: they are machine turns, not
 * conversations.
 */
export type ChatThreadOrigin = "web" | "internal";

export const WEB_THREAD_KEY_PREFIX = "public:";
export const SCHEDULE_THREAD_KEY_PREFIX = "schedule:";

export function chatThreadOrigin(externalKey: string | null): ChatThreadOrigin {
  return externalKey?.startsWith(WEB_THREAD_KEY_PREFIX) ? "web" : "internal";
}

export const webThreadFilter: SQL = like(
  chatThreads.externalKey,
  `${WEB_THREAD_KEY_PREFIX}%`
);

// NOT LIKE yields NULL (not true) on keyless threads, so those go in
// explicitly — and the schedule exclusion needs the same NULL guard, or it
// would silently drop every keyless (desktop) thread. Schedule-run threads
// are internal but machine-generated: the owner's chat list shows only their
// own conversations with the orchestrator.
export const internalThreadFilter: SQL = and(
  or(isNull(chatThreads.externalKey), notLike(chatThreads.externalKey, `${WEB_THREAD_KEY_PREFIX}%`)),
  or(isNull(chatThreads.externalKey), notLike(chatThreads.externalKey, `${SCHEDULE_THREAD_KEY_PREFIX}%`))
)!;
