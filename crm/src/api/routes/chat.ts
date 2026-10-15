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
import { leads, organizations, contacts, outbox, tickets, dossiers, chatThreads, chatMessages } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { ingestLead, changeLeadStage } from "../../domain/leads";
import { discoverContact } from "../../domain/contact-discovery";
import { normalizeResearchInput } from "../../domain/research-input";
import { createDossier } from "../../domain/dossiers";
import { createOutreachDraft } from "../../domain/outbox";
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
Research loop (same turn, never stop halfway): FIRST call discover_business_contact (or let research_and_save_prospect discover automatically), THEN call research_and_save_prospect to persist the lead and dossier. A discovery with no verified contact is a valid result: save the prospect anyway WITHOUT inventing an email, and tell the owner the contact needs manual completion.
Be concise, senior, and proactive. Highlight non-obvious opportunities.
Never assume: if you don't know a business fact, ask or research first.`,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stopWhen: stepCountIs(5),
        tools: {
          get_pipeline_summary: tool({
            description: "Get current summary of CRM leads, open support tickets, and pending outreach drafts.",
            parameters: z.object({}),
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
            parameters: z.object({
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

          discover_business_contact: tool({
            description:
              "Find real contact details (email, phone, website) for a business from its public website. " +
              "Call this BEFORE research_and_save_prospect when you don't have verified contact data. " +
              "Returns verified contacts observed on the company's pages, plus unverified suggestions (pattern-based, MX-valid domain) that a human must confirm. " +
              "If confidence is 'none', the prospect has no publishable contact: save it anyway WITHOUT inventing an email.",
            parameters: z.object({
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
              "Register a prospective business and save a verified research dossier into the CRM. " +
              "If you already called discover_business_contact, pass its verified email/phone. " +
              "Otherwise discovery runs automatically. NEVER invent an email like contact@domain: " +
              "leave contact empty when unknown so the lead is saved for manual completion. " +
              "Parámetros EXACTOS: companyName, contactEmail, contactPhone, domain, summary, pains, proposedSolution, sources.",
            parameters: z.object({
              companyName: z.string().optional().describe("Company or business name"),
              businessName: z.string().optional().describe("Alias of companyName"),
              contactEmail: z
                .string()
                .optional()
                .describe("Real, verified contact email. Leave empty if unknown."),
              contactPhone: z
                .string()
                .optional()
                .describe("Real, verified contact phone. Leave empty if unknown."),
              domain: z.string().optional().describe("Website domain"),
              summary: z.string().optional().describe("Executive diagnosis of opportunity and pains"),
              pains: z.array(z.string()).optional().describe("List of observed operational or technical pains"),
              proposedSolution: z.string().optional().describe("Creapolis.Dev high-ROI solution"),
              sources: z
                .array(
                  z.object({
                    url: z.string(),
                    note: z.string().optional(),
                  })
                )
                .optional()
                .describe("Verified source URLs (optional: the orchestrator cannot browse)"),
            }),
            execute: async (rawInput: unknown) => {
              // Validate FIRST: nothing is written to the DB until input is good.
              const normalized = normalizeResearchInput(rawInput);
              if (!normalized.ok) throw new Error(normalized.error);
              const research = normalized.value;

              let email = research.contactEmail;
              let phone = research.contactPhone;
              let website = research.domain;
              let contactConfidence: "given" | "page" | "domain" | "none" = email || phone ? "given" : "none";
              let suggestedEmails: string[] = [];

              if (!email && !phone) {
                const discovery = await discoverContact({ companyName: research.companyName, domain: website });
                email = discovery.verifiedEmails[0];
                phone = discovery.verifiedPhones[0];
                if (discovery.website) website = discovery.website;
                suggestedEmails = discovery.suggestedEmails;
                contactConfidence = discovery.confidence;
              }

              const ingested = await ingestLead({
                clientName: research.companyName,
                companyName: research.companyName,
                contact: email ?? phone,
                serviceType: "automation",
                projectSummary: research.summary,
                source: "orchestrator_chat",
                actor,
              });

              if (ingested.duplicate) {
                return {
                  success: true,
                  duplicate: true,
                  leadId: ingested.lead.id,
                  stage: ingested.lead.stage,
                  message: `Este negocio ya estaba prospectado (etapa ${ingested.lead.stage}). No se creó un duplicado.`,
                };
              }

              let dossier;
              try {
                dossier = await createDossier({
                  leadId: ingested.lead.id,
                  organizationId: ingested.lead.organizationId || undefined,
                  companyName: research.companyName,
                  domain: website,
                  summary: research.summary,
                  findings: {
                    pains: research.pains,
                    solution: research.proposedSolution,
                  },
                  sources: research.sources.map((s) => ({
                    url: s.url,
                    retrievedAt: new Date().toISOString(),
                    note: s.note,
                  })),
                  actor,
                });
              } catch (err) {
                // Roll back the lead so a failed save never leaves a junk row.
                await db.delete(leads).where(eq(leads.id, ingested.lead.id));
                throw new Error(
                  `No se pudo guardar el dossier y se descartó el lead parcial. Causa: ${err instanceof Error ? err.message : String(err)}. Reintenta con datos completos.`
                );
              }

              const transition = await changeLeadStage({
                leadId: ingested.lead.id,
                targetStage: "researched",
                reason: "dossier verificado",
                actor,
              });
              const moved = "success" in transition && transition.success === true;

              return {
                success: true,
                leadId: ingested.lead.id,
                dossierId: dossier.id,
                stage: moved ? "researched" : ingested.lead.stage,
                contact: email ?? phone ?? null,
                contactConfidence,
                suggestedEmails,
                message:
                  (email || phone
                    ? `Prospecto registrado con contacto verificado (confianza: ${contactConfidence}).`
                    : "Prospecto registrado SIN contacto verificado: completar manualmente antes de hacer outreach.") +
                  (moved ? " Etapa: researched." : " No se pudo avanzar la etapa: revisar transiciones."),
              };
            },
          }),

          create_support_ticket: tool({
            description: "Register a client support incident with contractual SLA calculation.",
            parameters: z.object({
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
            parameters: z.object({
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
                taskId: result.task.id,
                status: result.task.status,
              };
            },
          }),

          generate_marketing_post: tool({
            description: "Generate a high-converting social media marketing post for Instagram, Facebook, or LinkedIn with copy, hashtags, and Muse visual image prompt.",
            parameters: z.object({
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
