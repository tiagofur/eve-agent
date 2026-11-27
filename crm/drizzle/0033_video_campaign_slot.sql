-- Weekly campaign-video slot: Tuesday & Friday 09:30 UTC, right after the
-- morning image packs. The orchestrator calls generate_marketing_post with
-- format='video' (Gemini Omni renders a 5s vertical 9:16 clip, ~US$0.35) and
-- the post lands in Marketing Studio with the existing Telegram approval —
-- publishing stays manual (Reels/FB video upload), no auto-publish for video.
INSERT INTO "schedules" ("id", "name", "title", "cron", "prompt", "enabled", "source", "category", "kind", "next_run_at") VALUES
  ('10000000-0000-4000-8000-000000000041', 'video_campaign', 'Video de campaña (martes y viernes)', '30 9 * * 2,5',
   'Weekly campaign-video slot (runs Tuesday and Friday). Produce ONE short vertical video for the content pipeline:
1. Pick the brand by ISO week number of today''s date: even week → creapolis, odd week → pepinillo; if this is the first slot of a month (day ≤ 7) use solennix instead. Ground the angle in the brand''s product doc with search_product_docs (docs tipo pendiente are off-limits) and rotate the angle — never repeat the previous slot''s.
2. Define a 5-second scroll-stopper scene, VERTICAL 9:16, one visual idea, motion in the first second, absolutely no text inside the video (captions are added separately).
3. Call generate_marketing_post with platform=''instagram'', format=''video'' and a Spanish topic that names the brand plus the scene''s concept — the CRM renders the clip with Gemini Omni (~30s) and queues it for Telegram approval.
4. Report the postId, the brand and the angle in one line. NEVER publish — the owner approves 1-click on Telegram; video upload to IG/FB stays manual for now.',
   true, 'system', 'content', 'agent', NULL)
ON CONFLICT ("name") DO NOTHING;
