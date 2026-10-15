import { Hono } from "hono";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: "../.env.local" });
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { generateText, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createSubscriptionFetch } from "../../../../agent/lib/meta-subscription";
import { eq, asc, desc, sql, count } from "drizzle-orm";
import { db } from "../../db/client";
import { leads, organizations, contacts, outbox, tickets, chatThreads, chatMessages } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { discoverContact } from "../../domain/contact-discovery";
import { researchAndSaveProspect } from "../../domain/prospect-intake";
import { searchWeb } from "../../domain/web-search";
import { createTicket } from "../../domain/tickets";
import { createTask } from "../../domain/projects";

export const chatRouter = new Hono<{ Variables: AuthContextVariables }>();

function getModel() {
  const metaKey = process.env.META_API_KEY || process.env.MODEL_API_KEY;
  if (metaKey) {
    const meta = createOpenAI({
      name: "meta",
      baseURL: process.env.META_API_BASE_URL || "https://api.meta.ai/v1",
      apiKey: metaKey,
    });
    return meta(process.env.META_MODEL_ID || "muse-spark-1.3-contributor");
  }

  // Explicit OpenAI key always wins when set.
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai("gpt-4o-mini");
  }

  if (process.env.META_USE_SUBSCRIPTION === "0") {
    // Escape hatch back to the previous OpenAI default.
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY || "dummy",
    });
    return openai("gpt-4o-mini");
  }

  // Local-only Muse Code subscription (one-time login via
  // `node scripts/meta-login.mjs`). No API billing.
  const metaSubscription = createOpenAI({
    name: "meta-subscription",
    baseURL: process.env.META_API_BASE_URL || "https://api.meta.ai/v1",
    apiKey: "subscription",
    fetch: createSubscriptionFetch(),
  });
  return metaSubscription(process.env.META_MODEL_ID || "muse-spark-1.3-contributor");
}

// List threads (newest first)
chatRouter.get("/threads", requireScope(["ops"]), async (c) => {
  const threads = await db
    .select()
    .from(chatThreads)
    .orderBy(desc(chatThreads.updatedAt))
    .limit(50);
  return c.json({ threads });
});

// Create thread
chatRouter.post(
  "/threads",
  requireScope(["ops"]),
  zValidator("json", z.object({ title: z.string().max(120).optional() })),
  async (c) => {
    const { title } = c.req.valid("json");
    const [created] = await db
      .insert(chatThreads)
      .values({ title: title?.trim() || "Nueva conversación" })
      .returning();
    if (!created) return c.json({ error: "Failed to create thread" }, 500);
    return c.json({ thread: created });
  }
);

// Get thread with messages
chatRouter.get("/threads/:id", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing thread id" }, 400);
  const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id)).limit(1);
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  const msgs = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, id))
    .orderBy(asc(chatMessages.createdAt));
  return c.json({ thread, messages: msgs });
});

// Delete thread (messages cascade)
chatRouter.delete("/threads/:id", requireScope(["ops"]), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "Missing thread id" }, 400);
  await db.delete(chatThreads).where(eq(chatThreads.id, id));
  return c.json({ success: true });
});

chatRouter.post(
  "/",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      threadId: z.string().uuid().optional(),
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.string(),
        })
      ),
    })
  ),
  async (c) => {
    const { messages, threadId: requestedThreadId } = c.req.valid("json");
    const actor = c.get("actor");
    const model = getModel();

    // Resolve or create the conversation thread (persistent memory).
    let threadId = requestedThreadId;
    if (threadId) {
      const [existing] = await db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.id, threadId))
        .limit(1);
      if (!existing) return c.json({ error: "Thread not found" }, 404);
    } else {
      const firstUser = messages.find((m) => m.role === "user");
      const title = (firstUser?.content ?? "Nueva conversación").slice(0, 60);
      const [created] = await db.insert(chatThreads).values({ title }).returning();
      if (!created) return c.json({ error: "Failed to create thread" }, 500);
      threadId = created.id;
    }

    try {
      const result = await generateText({
        model,
        system: `You are the Executive AI Orchestrator for Creapolis.Dev (a high-performance software agency specializing in AI agents, automations, and modern web apps).
You are conversing with the owner/director of Creapolis.Dev in natural Spanish.
You have direct autonomous access to tools that query and manipulate the Creapolis CRM database:
- Check pipeline stats, search leads, research prospects, draft outreach, inspect support tickets, or dispatch coding tasks.
When the user asks you to research a business, look up data, or perform an action, ALWAYS use your tools.
Research loop (same turn, never stop halfway): when the owner asks you to FIND a prospect by criteria (industry, city, niche), FIRST call search_web for real candidates and pick the strongest one; when a business is already named, start at discovery. Then call discover_business_contact on the chosen candidate (or let research_and_save_prospect discover automatically), THEN call research_and_save_prospect with the COMPLETE template: companyName, summary (>=20 chars), pains (>=1), techStack, proposedSolution (>=20 chars), outreachAngle (>=20 chars), plus any verified contactEmail/contactPhone. A name-only record is NEVER a valid outcome: if you cannot fill the template from real data, tell the owner what is missing instead of saving a partial record. A discovery with no verified contact is a valid result: save the prospect anyway WITHOUT inventing an email, and tell the owner the contact needs manual completion. If search_web reports not_configured, explain how to enable it (SEARCH_API_KEY in crm/.env) and only research businesses the owner names explicitly.
Be concise, senior, and proactive. Highlight non-obvious opportunities.
Never assume: if you don't know a business fact, ask or research first.`,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stopWhen: stepCountIs(5),
        tools: {
          get_pipeline_summary: tool({
            description: "Get current summary of CRM leads, open support tickets, and pending outreach drafts.",
            inputSchema: z.object({}),
            execute: async () => {
              const [leadsCount] = await db.select({ total: count(leads.id) }).from(leads);
              const [openTickets] = await db
                .select({ total: count(tickets.id) })
                .from(tickets)
                .where(sql`${tickets.status} IN ('open', 'in_progress')`);
              const [pendingDrafts] = await db
                .select({ total: count(outbox.id) })
                .from(outbox)
                .where(eq(outbox.status, "pending_approval"));

              return {
                totalLeads: Number(leadsCount?.total ?? 0),
                openTickets: Number(openTickets?.total ?? 0),
                pendingApprovalDrafts: Number(pendingDrafts?.total ?? 0),
              };
            },
          }),

          search_leads: tool({
            description: "Search for leads or prospects in the CRM by name, company, or stage.",
            inputSchema: z.object({
              query: z.string().describe("Name, company, email, or stage keyword"),
            }),
            execute: async ({ query }) => {
              const rows = await db
                .select({
                  id: leads.id,
                  stage: leads.stage,
                  company: organizations.name,
                  contact: contacts.name,
                  email: contacts.email,
                  summary: leads.summary,
                  createdAt: leads.createdAt,
                })
                .from(leads)
                .leftJoin(organizations, eq(leads.organizationId, organizations.id))
                .leftJoin(contacts, eq(leads.contactId, contacts.id))
                .orderBy(desc(leads.createdAt))
                .limit(10);

              const q = query.toLowerCase();
              return rows.filter(
                (r) =>
                  !query ||
                  r.company?.toLowerCase().includes(q) ||
                  r.contact?.toLowerCase().includes(q) ||
                  r.stage.toLowerCase().includes(q) ||
                  r.summary?.toLowerCase().includes(q)
              );
            },
          }),

          search_web: tool({
            description:
              "Search the real web (Brave/Tavily) for local businesses and public information. " +
              "Use this FIRST when the owner asks to FIND a prospect by criteria (e.g. 'un dentista en Puerto Vallarta') " +
              "instead of guessing from memory. Returns a list of {title, url, snippet}: pick the best candidate, " +
              "then verify its contact with discover_business_contact. If it reports not_configured, tell the owner " +
              "to set SEARCH_API_KEY in crm/.env.",
            inputSchema: z.object({
              query: z
                .string()
                .describe("Search query in natural language, e.g. 'clínica dental Puerto Vallarta'"),
              count: z.number().optional().describe("Number of results (default 8, max 10)"),
            }),
            execute: async ({ query, count }) => {
              return searchWeb({ query, count });
            },
          }),

          discover_business_contact: tool({
            description:
              "Find real contact details (email, phone, website) for a business from its public website. " +
              "Call this BEFORE research_and_save_prospect when you don't have verified contact data. " +
              "Returns verified contacts observed on the company's pages, plus unverified suggestions (pattern-based, MX-valid domain) that a human must confirm. " +
              "If confidence is 'none', the prospect has no publishable contact: save it anyway WITHOUT inventing an email.",
            inputSchema: z.object({
              companyName: z.string().optional().describe("Company or business name"),
              businessName: z.string().optional().describe("Alias of companyName"),
              business_name: z.string().optional().describe("Alias of companyName"),
              domain: z.string().optional().describe("Website domain if known (e.g. empresa.com)"),
              website: z.string().optional().describe("Alias of domain"),
            }),
            execute: async (input) => {
              const companyName = input.companyName ?? input.businessName ?? "";
              if (!companyName.trim()) throw new Error("companyName (or businessName) is required");
              return discoverContact({ companyName, domain: input.domain ?? input.website });
            },
          }),

          research_and_save_prospect: tool({
            description:
              "Register a prospective business and save a COMPLETE research dossier into the CRM. " +
              "If you already called discover_business_contact, pass its verified email/phone. " +
              "Otherwise discovery runs automatically and its verified pages are saved as sources. " +
              "NEVER invent an email like contact@domain: leave contact empty when unknown so the " +
              "lead is saved for manual completion. If the business already exists as a partial, " +
              "name-only record, this tool completes it with the dossier instead of skipping it. " +
              "Parámetros EXACTOS: companyName, contactEmail, contactPhone, domain, summary, pains, " +
              "techStack, proposedSolution, outreachAngle, sources.",
            inputSchema: z.object({
              companyName: z.string().optional().describe("Company or business name"),
              businessName: z.string().optional().describe("Alias of companyName"),
              contactEmail: z
                .string()
                .optional()
                .describe("Real, verified contact email. Leave empty if unknown."),
              contactPhone: z
                .string()
                .optional()
                .describe("Real, verified contact phone (WhatsApp). Leave empty if unknown."),
              domain: z.string().optional().describe("Website domain"),
              summary: z
                .string()
                .optional()
                .describe("Executive diagnosis of opportunity and pains (at least 20 characters)"),
              pains: z.array(z.string()).optional().describe("List of observed operational or technical pains (at least 1)"),
              techStack: z
                .array(z.string())
                .optional()
                .describe("Tools and technologies observed (e.g. WordPress, manual WhatsApp). Empty if no web presence."),
              proposedSolution: z
                .string()
                .optional()
                .describe("Creapolis.Dev high-ROI solution (at least 20 characters)"),
              outreachAngle: z
                .string()
                .optional()
                .describe("Opening angle for the first outreach message (at least 20 characters)"),
              sources: z
                .array(
                  z.object({
                    url: z.string(),
                    note: z.string().optional(),
                  })
                )
                .optional()
                .describe("Verified source URLs (optional: pages verified by discovery are saved automatically)"),
            }),
            execute: async (rawInput: unknown) => {
              // Validation, dedup-completion, sources and rollback live in the
              // domain so every caller gets the same guarantees and tests cover it.
              const result = await researchAndSaveProspect(rawInput, { actor });

              return {
                success: true,
                outcome: result.outcome,
                leadId: result.leadId,
                dossierId: result.dossierId,
                stage: result.stage,
                contact: result.contact,
                contactConfidence: result.contactConfidence,
                suggestedEmails: result.suggestedEmails,
                website: result.website,
                sourcesCount: result.sourcesCount,
                message: result.message,
              };
            },
          }),

          create_support_ticket: tool({
            description: "Register a client support incident with contractual SLA calculation.",
            inputSchema: z.object({
              clientName: z.string(),
              contact: z.string(),
              system: z.string(),
              severity: z.enum(["critical", "major", "minor"]),
              description: z.string(),
            }),
            execute: async (input) => {
              const result = await createTicket({
                ...input,
                actor,
              });
              return {
                success: true,
                ticketId: result.ticket.id,
                slaDueAt: result.ticket.slaDueAt,
                severity: result.ticket.severity,
              };
            },
          }),

          dispatch_coding_task: tool({
            description: "Dispatch an autonomous coding task spec to the terminal coding worker (gentle-shell).",
            inputSchema: z.object({
              projectId: z.string().uuid(),
              title: z.string(),
              spec: z.string(),
            }),
            execute: async (input) => {
              const result = await createTask({
                ...input,
                assignee: "gentle-shell",
                actor,
              });
              return {
                success: true,
                taskId: result.id,
                status: result.status,
              };
            },
          }),

          generate_marketing_post: tool({
            description: "Generate a high-converting social media marketing post for Instagram, Facebook, or LinkedIn with copy, hashtags, and Muse visual image prompt.",
            inputSchema: z.object({
              platform: z.enum(["instagram", "facebook", "linkedin", "twitter"]),
              topic: z.string().describe("Topic or case study to promote (e.g. WhatsApp AI Agent for Medical Clinics)"),
              tone: z.string().optional().describe("Voice tone"),
            }),
            execute: async ({ platform, topic, tone }) => {
              const { createSocialPost } = await import("../../domain/marketing");
              const marketingPrompt = `You are the Lead Marketing Specialist for Creapolis.Dev. Generate a high-converting social post for ${platform.toUpperCase()}.
TOPIC: ${topic}
TONE: ${tone || "Modern, authoritative, builder-oriented, clear ROI, no generic corporate buzzwords"}

Respond ONLY with valid JSON:
{
  "caption": "Post caption with emojis, hook, problem, solution, ROI, and call to action (in natural Spanish)",
  "hashtags": ["CreapolisDev", "AIAgents", "Automation"],
  "imagePrompt": "Detailed English prompt for generative image models (Muse Image, Midjourney). Style: sleek dark tech aesthetic, dark gray/zinc background, glowing emerald/cyan neon accents, clean geometric 3D shapes or futuristic agent dashboard, high resolution, 8k render, no blurry text."
}`;
              const { text } = await generateText({
                model,
                messages: [{ role: "user", content: marketingPrompt }],
              });
              const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
              const parsed = JSON.parse(cleaned);

              const result = await createSocialPost({
                platform,
                topic,
                caption: parsed.caption,
                hashtags: parsed.hashtags || [],
                imagePrompt: parsed.imagePrompt,
                actor,
              });

              return {
                success: true,
                postId: result.post.id,
                platform: result.post.platform,
                topic: result.post.topic,
                status: result.post.status,
                message: `Post generado para ${platform.toUpperCase()} y enviado a Telegram para aprobación ejecutiva.`,
              };
            },
          }),
        },
      });

      const toolCalls = result.steps?.flatMap((s) => s.toolCalls || []);

      // Persist the turn: last user message + assistant reply.
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (lastUser) {
        await db.insert(chatMessages).values({ threadId, role: "user", content: lastUser.content });
      }
      await db.insert(chatMessages).values({
        threadId,
        role: "assistant",
        content: result.text,
        toolCalls: toolCalls ?? null,
      });
      await db.update(chatThreads).set({ updatedAt: new Date() }).where(eq(chatThreads.id, threadId));

      return c.json({
        reply: result.text,
        toolCalls,
        threadId,
      });
    } catch (err: any) {
      console.error("Chat orchestration error:", err);
      return c.json({ error: err.message || "Failed to process message" }, 500);
    }
  }
);
