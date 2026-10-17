ALTER TABLE "chat_threads" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_external_key_unique" UNIQUE("external_key");