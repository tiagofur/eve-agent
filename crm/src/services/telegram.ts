import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: "../.env.local" });
dotenv.config({ path: ".env.local" });
import { db } from "../db/client";
import { count, eq, sql } from "drizzle-orm";
import { leads, tickets, outbox, contacts, organizations, socialPosts } from "../db/schema";
import { reviewOutreachDraft } from "../domain/outbox";
import { updateTicketStatus } from "../domain/tickets";

function getCredentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  return { token, adminChatId };
}

export function escapeHtml(str: string): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function sendTelegramMessage(
  text: string,
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  parseMode: "HTML" | "Markdown" = "HTML"
) {
  const { token, adminChatId } = getCredentials();
  if (!token || !adminChatId) {
    console.error("[Telegram] Credentials missing in environment");
    return { ok: false, error: "Telegram credentials not configured" };
  }

  const payload: any = {
    chat_id: adminChatId,
    text,
    parse_mode: parseMode,
  };

  if (inlineKeyboard && inlineKeyboard.length > 0) {
    payload.reply_markup = {
      inline_keyboard: inlineKeyboard,
    };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as any;
    if (!data.ok) {
      console.error("[Telegram] sendMessage API error:", data);
    }
    return data;
  } catch (err: any) {
    console.error("[Telegram] Failed to send telegram message:", err);
    return { ok: false, error: err.message };
  }
}

export async function sendTelegramPhoto(
  photoBase64: string,
  caption: string,
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>
) {
  const { token, adminChatId } = getCredentials();
  if (!token || !adminChatId) return { ok: false };

  const buffer = Buffer.from(photoBase64, "base64");
  const blob = new Blob([buffer], { type: "image/webp" });
  const formData = new FormData();
  formData.append("chat_id", adminChatId);
  formData.append("photo", blob, "creative.webp");
  formData.append("caption", caption);
  formData.append("parse_mode", "HTML");

  if (inlineKeyboard && inlineKeyboard.length > 0) {
    formData.append("reply_markup", JSON.stringify({ inline_keyboard: inlineKeyboard }));
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: formData,
    });
    return (await res.json()) as any;
  } catch (err: any) {
    console.error("[Telegram] Failed to send telegram photo:", err);
    return { ok: false, error: err.message };
  }
}


export async function editTelegramMessage(
  messageId: number,
  chatId: number | string,
  text: string,
  inlineKeyboard?: Array<Array<{ text: string; callback_data: string }>>,
  parseMode: "HTML" | "Markdown" = "HTML"
) {
  const { token } = getCredentials();
  if (!token) return;

  const payload: any = {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: parseMode,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : { inline_keyboard: [] },
  };

  try {
    // Attempt editing message text first
    const res = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, text }),
    });
    const data = await res.json();
    if (!data.ok) {
      // If message is a media/photo message, Telegram requires editMessageCaption
      const captionRes = await fetch(`https://api.telegram.org/bot${token}/editMessageCaption`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, caption: text }),
      });
      const captionData = await captionRes.json();
      if (!captionData.ok) {
        console.error("[Telegram] editMessageCaption API error:", captionData);
      }
    }
  } catch (err) {
    console.error("[Telegram] Failed to edit telegram message:", err);
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  const { token } = getCredentials();
  if (!token) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
      }),
    });
  } catch (err) {
    console.error("Failed to answer callback query:", err);
  }
}

export async function notifyOutboxDraftCreated(draftId: string) {
  const [draft] = await db
    .select({
      id: outbox.id,
      channel: outbox.channel,
      subject: outbox.subject,
      body: outbox.body,
      rationale: outbox.rationale,
      contactName: contacts.name,
      contactEmail: contacts.email,
      contactPhone: contacts.phone,
    })
    .from(outbox)
    .leftJoin(contacts, eq(outbox.contactId, contacts.id))
    .where(eq(outbox.id, draftId))
    .limit(1);

  if (!draft) return;

  const contactDisplay = escapeHtml(`${draft.contactName || "Contacto"} (${draft.contactEmail || draft.contactPhone || "N/A"})`);
  const channelDisplay = escapeHtml(draft.channel.toUpperCase());
  const subjectDisplay = escapeHtml(draft.subject || "Sin asunto");
  const rationaleDisplay = escapeHtml(draft.rationale || "Outreach personalizado");
  const bodyDisplay = escapeHtml(draft.body.slice(0, 1000) + (draft.body.length > 1000 ? "..." : ""));

  const text = `📬 <b>NUEVO BORRADOR EN OUTBOX</b>
<i>Requiere Aprobación Ejecutiva (Human-in-the-Loop)</i>

<b>Destinatario:</b> ${contactDisplay}
<b>Canal:</b> <code>${channelDisplay}</code>
<b>Asunto:</b> ${subjectDisplay}
<b>Fundamento IA:</b> ${rationaleDisplay}

<b>Mensaje Propuesto:</b>
<pre>${bodyDisplay}</pre>

¿Deseas autorizar el envío?`;

  const keyboard = [
    [
      { text: "✅ Aprobar Envío", callback_data: `approve_draft:${draft.id}` },
      { text: "❌ Rechazar", callback_data: `reject_draft:${draft.id}` },
    ],
  ];

  return await sendTelegramMessage(text, keyboard, "HTML");
}

export async function notifyCriticalTicketCreated(ticketId: string) {
  const [ticket] = await db
    .select({
      id: tickets.id,
      severity: tickets.severity,
      system: tickets.system,
      description: tickets.description,
      slaDueAt: tickets.slaDueAt,
      contactName: contacts.name,
      contactEmail: contacts.email,
    })
    .from(tickets)
    .leftJoin(contacts, eq(tickets.contactId, contacts.id))
    .where(eq(tickets.id, ticketId))
    .limit(1);

  if (!ticket) return;

  const text = `🚨 <b>INCIDENTE DE SOPORTE (${ticket.severity.toUpperCase()})</b>
<i>Contrato SLA Activo</i>

<b>Cliente:</b> ${escapeHtml(ticket.contactName || "Cliente")} (${escapeHtml(ticket.contactEmail || "N/A")})
<b>Sistema Afectado:</b> <code>${escapeHtml(ticket.system)}</code>
<b>Vencimiento SLA:</b> ${new Date(ticket.slaDueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
<b>Detalle:</b>
<pre>${escapeHtml(ticket.description)}</pre>

Acción inmediata requerida:`;

  const keyboard = [
    [
      { text: "⚡ En Progreso", callback_data: `progress_ticket:${ticket.id}` },
      { text: "✅ Resolver", callback_data: `resolve_ticket:${ticket.id}` },
    ],
  ];

  return await sendTelegramMessage(text, keyboard, "HTML");
}

export async function notifySocialPostCreated(postId: string) {
  const [post] = await db
    .select()
    .from(socialPosts)
    .where(eq(socialPosts.id, postId))
    .limit(1);

  if (!post) return;

  const platformUpper = post.platform.toUpperCase();
  const hashtagsFormatted = (post.hashtags || []).map((h) => `#${escapeHtml(h.replace(/^#/, ""))}`).join(" ");

  const text = `🎨 <b>NUEVA PUBLICACIÓN SOCIAL (${platformUpper})</b>
<i>Generado por Subagente de Marketing</i>

<b>Tema:</b> ${escapeHtml(post.topic)}
${hashtagsFormatted ? `<b>Hashtags:</b> ${hashtagsFormatted}\n` : ""}
<b>Copy Propuesto:</b>
<pre>${escapeHtml(post.caption.slice(0, 900) + (post.caption.length > 900 ? "..." : ""))}</pre>

${post.imagePrompt ? `<b>Prompt Visual (Muse Image):</b>\n<code>${escapeHtml(post.imagePrompt.slice(0, 400))}</code>\n\n` : ""}¿Deseas autorizar la publicación en ${platformUpper}?`;

  const keyboard = [
    [
      { text: `✅ Aprobar para ${platformUpper}`, callback_data: `approve_post:${post.id}` },
      { text: "❌ Rechazar", callback_data: `reject_post:${post.id}` },
    ],
  ];

  if (post.imageUrl && (post.imageUrl.startsWith("data:image/") || !post.imageUrl.startsWith("http"))) {
    const rawB64 = post.imageUrl.includes(",") ? post.imageUrl.split(",")[1] : post.imageUrl;
    if (rawB64) {
      const photoCaption = `🎨 <b>NUEVA PUBLICACIÓN SOCIAL (${platformUpper})</b>\n\n<b>Tema:</b> ${escapeHtml(post.topic)}\n\n¿Deseas autorizar la publicación en ${platformUpper}?`;
      return await sendTelegramPhoto(rawB64, photoCaption, keyboard);
    }
    // Malformed base64 payload: fall through to the text message so the
    // approval flow still reaches the owner.
  }

  return await sendTelegramMessage(text, keyboard, "HTML");
}

let isPolling = false;

export async function startTelegramPolling() {
  const { token, adminChatId } = getCredentials();
  if (!token || !adminChatId) {
    console.log("[Telegram] Service disabled (no credentials in env)");
    return;
  }

  if (isPolling) return;
  isPolling = true;

  console.log(`[Telegram] Service active for Admin Chat ID: ${adminChatId}`);
  let offset = 0;

  const poll = async () => {
    while (isPolling) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=20`,
          { signal: AbortSignal.timeout(30000) }
        );
        const data = (await res.json()) as any;

        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            offset = update.update_id + 1;

            // 1. Handle Callback Query (Buttons)
            if (update.callback_query) {
              const cq = update.callback_query;
              const cqData = cq.data as string;
              const msg = cq.message;

              if (cqData.startsWith("approve_draft:")) {
                const draftId = cqData.replace("approve_draft:", "");
                const result = await reviewOutreachDraft({
                  draftId,
                  decision: "approved",
                  actor: "telegram_admin",
                });

                if (result.success) {
                  await answerCallbackQuery(cq.id, "✅ Borrador aprobado y listo para entrega.");
                  await editTelegramMessage(
                    msg.message_id,
                    msg.chat.id,
                    `${msg.text}\n\n✅ *Aprobado por Administrador vía Telegram a las ${new Date().toLocaleTimeString()}*`
                  );
                } else {
                  await answerCallbackQuery(cq.id, `⚠️ ${result.message}`);
                }
              } else if (cqData.startsWith("reject_draft:")) {
                const draftId = cqData.replace("reject_draft:", "");
                const result = await reviewOutreachDraft({
                  draftId,
                  decision: "rejected",
                  rejectedReason: "Rechazado desde Telegram",
                  actor: "telegram_admin",
                });

                if (result.success) {
                  await answerCallbackQuery(cq.id, "❌ Borrador rechazado.");
                  await editTelegramMessage(
                    msg.message_id,
                    msg.chat.id,
                    `${msg.text}\n\n❌ *Rechazado vía Telegram a las ${new Date().toLocaleTimeString()}*`
                  );
                } else {
                  await answerCallbackQuery(cq.id, `⚠️ ${result.message}`);
                }
              } else if (cqData.startsWith("progress_ticket:")) {
                const ticketId = cqData.replace("progress_ticket:", "");
                const result = await updateTicketStatus({
                  ticketId,
                  status: "in_progress",
                  reason: "Atención iniciada desde Telegram",
                  actor: "telegram_admin",
                });

                if (result.success) {
                  await answerCallbackQuery(cq.id, "⚡ Ticket en progreso.");
                  await editTelegramMessage(
                    msg.message_id,
                    msg.chat.id,
                    `${msg.text}\n\n⚡ *En progreso atendido por Administrador a las ${new Date().toLocaleTimeString()}*`
                  );
                }
              } else if (cqData.startsWith("resolve_ticket:")) {
                const ticketId = cqData.replace("resolve_ticket:", "");
                const result = await updateTicketStatus({
                  ticketId,
                  status: "resolved",
                  reason: "Resuelto desde Telegram",
                  actor: "telegram_admin",
                });

                if (result.success) {
                  await answerCallbackQuery(cq.id, "✅ Ticket marcado como resuelto.");
                  await editTelegramMessage(
                    msg.message_id,
                    msg.chat.id,
                    `${msg.text}\n\n✅ *Resuelto vía Telegram a las ${new Date().toLocaleTimeString()}*`
                  );
                }
              } else if (cqData.startsWith("approve_post:")) {
                const postId = cqData.replace("approve_post:", "");
                const { reviewSocialPost, publishSocialPost } = await import("../domain/marketing");
                const originalContent = msg.text || msg.caption || "";

                const reviewRes = await reviewSocialPost({
                  postId,
                  decision: "approved",
                  actor: "telegram_admin",
                });

                if (reviewRes.success) {
                  await answerCallbackQuery(cq.id, "🚀 Aprobando y enviando a Meta...");
                  try {
                    const pubRes = await publishSocialPost(postId, "telegram_admin");
                    const postUrl = pubRes.publishResult?.externalPostUrl || "";
                    const postIdMeta = pubRes.publishResult?.externalPostId || "";
                    await editTelegramMessage(
                      msg.message_id,
                      msg.chat.id,
                      `${originalContent}\n\n🚀 <b>¡PUBLICADO EN META CON ÉXITO!</b>\n🆔 ID: <code>${escapeHtml(postIdMeta)}</code>${postUrl ? `\n🔗 <a href="${postUrl}">Ver publicación</a>` : ""}`,
                      undefined,
                      "HTML"
                    );
                  } catch (publishErr: any) {
                    console.error("Meta auto-publish error after approval:", publishErr);
                    await editTelegramMessage(
                      msg.message_id,
                      msg.chat.id,
                      `${originalContent}\n\n⚠️ <b>Aprobado en CRM, pero falló el envío a Meta:</b> ${escapeHtml(publishErr.message)}`,
                      undefined,
                      "HTML"
                    );
                  }
                } else {
                  await answerCallbackQuery(cq.id, "Error al aprobar.");
                }
              } else if (cqData.startsWith("reject_post:")) {
                const postId = cqData.replace("reject_post:", "");
                const { reviewSocialPost } = await import("../domain/marketing");
                const originalContent = msg.text || msg.caption || "";

                const result = await reviewSocialPost({
                  postId,
                  decision: "rejected",
                  rejectedReason: "Rechazado desde Telegram",
                  actor: "telegram_admin",
                });

                if (result.success) {
                  await answerCallbackQuery(cq.id, "❌ Publicación rechazada.");
                  await editTelegramMessage(
                    msg.message_id,
                    msg.chat.id,
                    `${originalContent}\n\n❌ <b>Rechazado vía Telegram a las ${new Date().toLocaleTimeString()}</b>`,
                    undefined,
                    "HTML"
                  );
                } else {
                  await answerCallbackQuery(cq.id, "Error al rechazar.");
                }
              }
            }

            // 2. Handle Text Commands (/status, /pipeline, /ayuda)
            if (update.message?.text) {
              const text = update.message.text.trim();
              const chatId = update.message.chat.id;

              if (text === "/status" || text === "/pipeline") {
                const [leadsCount] = await db.select({ total: count(leads.id) }).from(leads);
                const [openTickets] = await db
                  .select({ total: count(tickets.id) })
                  .from(tickets)
                  .where(sql`${tickets.status} IN ('open', 'in_progress')`);
                const [pendingDrafts] = await db
                  .select({ total: count(outbox.id) })
                  .from(outbox)
                  .where(eq(outbox.status, "pending_approval"));

                const reply = `📊 *Creapolis.Dev — Pipeline Status*

• *Total Leads:* ${leadsCount?.total ?? 0}
• *Tickets SLA Abiertos:* ${openTickets?.total ?? 0}
• *Borradores Pendientes de Aprobación:* ${pendingDrafts?.total ?? 0}

_Servidor CRM en línea (:8787)_`;

                await sendTelegramMessage(reply);
              } else if (text === "/followups" || text === "/seguimientos") {
                const now = new Date();
                const overdueLeads = await db
                  .select({ id: leads.id, name: organizations.name, note: leads.followUpNote, at: leads.nextFollowUpAt })
                  .from(leads)
                  .leftJoin(organizations, eq(leads.organizationId, organizations.id))
                  .where(
                    sql`${leads.nextFollowUpAt} IS NOT NULL AND ${leads.nextFollowUpAt} <= ${now} AND ${leads.stage} != 'lost'`
                  )
                  .limit(10);
                const overdueTickets = await db
                  .select({ id: tickets.id, name: tickets.system, note: tickets.followUpNote, at: tickets.nextFollowUpAt })
                  .from(tickets)
                  .where(
                    sql`${tickets.nextFollowUpAt} IS NOT NULL AND ${tickets.nextFollowUpAt} <= ${now} AND ${tickets.status} NOT IN ('resolved', 'closed')`
                  )
                  .limit(10);
                const lines = [
                  ...overdueLeads.map(
                    (l) => `• Lead ${escapeHtml(l.name ?? l.id.slice(0, 8))}${l.note ? ` — ${escapeHtml(l.note)}` : ""}`
                  ),
                  ...overdueTickets.map(
                    (t) => `• Ticket ${escapeHtml(t.name)}${t.note ? ` — ${escapeHtml(t.note)}` : ""}`
                  ),
                ];
                const reply =
                  lines.length === 0
                    ? `✅ <b>Sin seguimientos vencidos.</b> Todo al día.`
                    : `🔔 <b>Seguimientos vencidos (${lines.length})</b>\n\n${lines.join("\n")}`;
                await sendTelegramMessage(reply);
              } else if (text === "/start" || text === "/ayuda") {
                const reply = `👋 *Creapolis Mission Control Bot*

Comandos disponibles:
• \`/pipeline\` o \`/status\` - Métricas en tiempo real del CRM.
• \`/followups\` - Seguimientos vencidos (leads y tickets).
• Recibirás notificaciones interactivas automáticas cuando haya borradores en outbox o tickets de soporte con SLA crítico.`;
                await sendTelegramMessage(reply);
              }
            }
          }
        }
      } catch (err) {
        // Wait 3 seconds on error before retry
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  };

  poll();
}
