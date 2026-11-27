ALTER TABLE "chat_threads" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
-- Web chats that predate the "Contactos web" inbox were never flagged for
-- review: file them as reviewed history so the inbox starts clean and only
-- counts the contacts that arrive from now on.
UPDATE "chat_threads" SET "reviewed_at" = "updated_at" WHERE "external_key" LIKE 'public:%';
