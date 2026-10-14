import { Hono } from "hono";
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: "../.env.local" });
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { generateText, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { eq, desc, sql, count } from "drizzle-orm";
import { db } from "../../db/client";
import { leads, organizations, contacts, outbox, tickets, dossiers } from "../../db/schema";
import { requireScope, type AuthContextVariables } from "../auth-middleware";
import { ingestLead } from "../../domain/leads";
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

  // Fallback to OpenAI if configured, or default
  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY || "dummy",
  });
  return openai("gpt-4o-mini");
}

chatRouter.post(
  "/",
  requireScope(["ops"]),
  zValidator(
    "json",
    z.object({
      messages: z.array(
        z.object({
          role: z.enum(["user", "assistant", "system"]),
          content: z.string(),
        })
      ),
    })
  ),
  async (c) => {
    const { messages } = c.req.valid("json");
    const actor = c.get("actor");
    const model = getModel();

    try {
      const result = await generateText({
        model,
        system: `You are the Executive AI Orchestrator for Creapolis.Dev (a high-performance software agency specializing in AI agents, automations, and modern web apps).
You are conversing with the owner/director of Creapolis.Dev in natural Spanish.
You have direct autonomous access to tools that query and manipulate the Creapolis CRM database:
- Check pipeline stats, search leads, research prospects, draft outreach, inspect support tickets, or dispatch coding tasks.
When the user asks you to research a business, look up data, or perform an action, ALWAYS use your tools.
Be concise, senior, and proactive. Highlight non-obvious opportunities.
Never assume: if you don't know a business fact, ask or research first.`,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        maxSteps: 5,
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

          research_and_save_prospect: tool({
            description: "Register a prospective business and save a verified research dossier into the CRM.",
            parameters: z.object({
              companyName: z.string().describe("Company or business name"),
              contactEmail: z.string().optional().describe("Contact email if known"),
              domain: z.string().optional().describe("Website domain"),
              summary: z.string().describe("Executive diagnosis of opportunity and pains"),
              pains: z.array(z.string()).describe("List of observed operational or technical pains"),
              proposedSolution: z.string().describe("Creapolis.Dev high-ROI solution"),
              sources: z.array(
                z.object({
                  url: z.string(),
                  note: z.string().optional(),
                })
              ),
            }),
            execute: async (input) => {
              const ingested = await ingestLead({
                clientName: input.companyName,
                companyName: input.companyName,
                contact: input.contactEmail || `contact@${input.domain || "prospect.local"}`,
                serviceType: "automation",
                projectSummary: input.summary,
                source: "orchestrator_chat",
                actor,
              });

              const dossier = await createDossier({
                leadId: ingested.lead.id,
                organizationId: ingested.lead.organizationId || undefined,
                companyName: input.companyName,
                domain: input.domain,
                summary: input.summary,
                findings: {
                  pains: input.pains,
                  solution: input.proposedSolution,
                },
                sources: input.sources.map((s) => ({
                  url: s.url,
                  retrievedAt: new Date().toISOString(),
                  note: s.note,
                })),
                actor,
              });

              return {
                success: true,
                leadId: ingested.lead.id,
                dossierId: dossier.id,
                stage: "researched",
                message: "Prospecto registrado y dossier verificado guardado en CRM.",
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

      return c.json({
        reply: result.text,
        toolCalls: result.steps?.flatMap((s) => s.toolCalls || []),
      });
    } catch (err: any) {
      console.error("Chat orchestration error:", err);
      return c.json({ error: err.message || "Failed to process message" }, 500);
    }
  }
);
