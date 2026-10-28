import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message, Thread } from "chat";
import { chatSdkChannel } from "eve/channels/chat-sdk";

const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim();

// Per-sender throttle: bounds how many full agent turns one WhatsApp user
// can start per window. In-memory like the CRM's IP limiter, so a restart
// resets it — acceptable, it only briefly widens the window.
const THROTTLE_MAX = Number(process.env.WHATSAPP_THROTTLE_MAX ?? 20);
const THROTTLE_WINDOW_MS =
  Number(process.env.WHATSAPP_THROTTLE_WINDOW_MINUTES ?? 10) * 60_000;

const THROTTLE_NOTICE =
  "Recibí muchos mensajes tuyos en muy poco tiempo. Espera unos minutos y con gusto seguimos 🙏";

const throttle = new Map<string, { count: number; resetAt: number; notified: boolean }>();

function senderKey(message: Message): string {
  return message.author.userId || message.author.userName || "unknown";
}

/** Returns whether the sender still has budget, and whether to notify once. */
function consumeThrottle(senderId: string): { allowed: boolean; notify: boolean } {
  const now = Date.now();
  const entry = throttle.get(senderId);
  if (!entry || now > entry.resetAt) {
    throttle.set(senderId, {
      count: 1,
      resetAt: now + THROTTLE_WINDOW_MS,
      notified: false,
    });
    return { allowed: true, notify: false };
  }
  if (entry.count >= THROTTLE_MAX) {
    if (entry.notified) return { allowed: false, notify: false };
    entry.notified = true;
    return { allowed: false, notify: true };
  }
  entry.count++;
  return { allowed: true, notify: false };
}

// Every WhatsApp sender is a PUBLIC principal: agent/lib/guard.ts denies
// staff-only tools to this authenticator.
function whatsappAuth(message: Message) {
  return {
    authenticator: "whatsapp",
    principalType: "user",
    principalId: senderKey(message),
    attributes: {},
  };
}

async function handleInbound(thread: Thread, message: Message) {
  const { allowed, notify } = consumeThrottle(senderKey(message));
  if (!allowed) {
    // Static notice posted directly to the thread — must NOT start a turn.
    if (notify) await thread.post(THROTTLE_NOTICE);
    return;
  }
  await send(message.text, { thread, auth: whatsappAuth(message) });
}

export const { bot, channel, send } = chatSdkChannel({
  userName: "Creapolis.Dev",
  adapters: token
    ? {
        whatsapp: (await import("@chat-adapter/whatsapp")).createWhatsAppAdapter({
          accessToken: token,
        }),
      }
    : {},
  state: createMemoryState(),
  resolveInputAuth: (event) => ({
    authenticator: "whatsapp",
    principalType: "user",
    principalId: event.user?.userId ?? "unknown",
    attributes: {},
  }),
});

bot.onNewMention(async (thread: Thread, message: Message) => {
  await thread.subscribe();
  await handleInbound(thread, message);
});

bot.onSubscribedMessage(async (thread: Thread, message: Message) => {
  await handleInbound(thread, message);
});

export default channel;
