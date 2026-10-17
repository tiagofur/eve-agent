# Telegram orchestrator chat — ask for prospects without the computer

Extends the existing CRM Telegram daemon so free-text messages from the
owner's admin chat reach the orchestrator through the same eve proxy the
desktop chat uses. One bot: conversation and draft approvals live in the
same Telegram chat.

## Specs

- S1 (user, verbatim): "pero no puedo pedir lo mismo desde telegran si no tengo la computadora cerca?"
- S2 (user decision): "Sí, un solo bot (recomendado)" — extend the current daemon; no second bot; free text only from the admin chat id (TELEGRAM_ADMIN_CHAT_ID); ack on start, final reply when the turn completes; honest error messages on failure.
- S3 (constraint carried from prospect-outreach-flow L4): crm/src/api/routes/chat.ts, crm/src/domain/eve-client.ts and eve-client.test.ts hold uncommitted user WIP — never edit or stage them. The turn logic lives in a new module built on eve-client's existing exports (resolveEveProxyConfig, createEveSession, sendEveMessage, readEveStreamToTerminal).
- S4 (verified behavior today): the daemon polls getUpdates as the single consumer of the bot token; free text is silently ignored; only /pipeline, /status, /followups, /seguimientos, /start, /ayuda and inline callbacks are handled.

## Tasks

- T1, S1/S2 — CRM: migration adds `chat_threads.external_key` (nullable, unique) + `ensureExternalThread` domain helper (find-or-create by key `telegram:<chat_id>`). Tests. Route: inline. Commit: pending.
- T2, S2/S3 — CRM: new domain module `telegram-chat` with `runOrchestratorTurn`: create/reuse the eve session with dead-session recovery, persist user + assistant messages in chat_threads/chat_messages, extract the final assistant reply. Tests with a mocked eve client. Route: inline. Commit: pending.
- T3, S2/S4 — CRM daemon: non-command text from the admin chat runs an orchestrator turn (immediate ack, sequential per-thread queue, honest error reply); non-admin chats stay ignored; /ayuda documents the chat. Route: inline. Commit: pending.
- T4, S1-S4 — verification: CRM suite + typecheck + one live turn driven through the domain module against :3000; user performs the true Telegram E2E. Route: inline. Commit: pending.

## Log

- L1 (user, verbatim): "el proceso desde la app desktop de MacOS parece estar perfecto ahora, llego en Telegram el mensaje de aprobar o rechazar, tambien en la app Desktop tengo en Leads & Pipeline lo mismo, todo va bien con este proveso... pero no puedo pedir lo mismo desde telegran si no tengo la computadora cerca?"
- L2 (user decision): "Sí, un solo bot (recomendado)".
- L3 (design evidence): Telegram allows exactly one getUpdates consumer per bot token — the CRM daemon already owns it, so a second eve channel bot would conflict. resolveEveProxyConfig/createEveSession/sendEveMessage/readEveStreamToTerminal are exported by eve-client and reusable without editing the user's WIP files.
