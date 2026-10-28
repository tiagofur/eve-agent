import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export const leadStageEnum = pgEnum("lead_stage", [
  "new",
  "researched",
  "contacted",
  "qualified",
  "discovery",
  "proposal",
  "contract",
  "won",
  "lost",
  "onboarding",
  "active",
  "support",
]);

export const channelEnum = pgEnum("channel", [
  "whatsapp",
  "email",
  "telegram",
  "linkedin",
  "phone",
  "web",
  "other",
]);

export const directionEnum = pgEnum("direction", ["inbound", "outbound"]);

export const serviceTypeEnum = pgEnum("service_type", [
  "software_development",
  "automation",
  "ai_implementation",
  "consulting",
]);

export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending_approval",
  "approved",
  "sent",
  "rejected",
  "failed",
]);

export const ticketSeverityEnum = pgEnum("ticket_severity", ["critical", "major", "minor"]);

export const ticketKindEnum = pgEnum("ticket_kind", ["support", "info"]);

export const ticketStatusEnum = pgEnum("ticket_status", [
  "open",
  "in_progress",
  "waiting_client",
  "resolved",
  "closed",
]);

export const projectStatusEnum = pgEnum("project_status", [
  "onboarding",
  "active",
  "paused",
  "delivered",
  "cancelled",
]);

export const taskStatusEnum = pgEnum("task_status", [
  "backlog",
  "pending_approval",
  "approved",
  "ready",
  "dispatched",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "rejected",
]);

export const taskKindEnum = pgEnum("task_kind", ["feature", "correction"]);

export const taskRunStatusEnum = pgEnum("task_run_status", ["running", "succeeded", "failed"]);

export const contractStatusEnum = pgEnum("contract_status", [
  "draft",
  "in_review",
  "sent",
  "signed",
  "void",
]);

export const apiScopeEnum = pgEnum("api_scope", ["front", "ops", "owner", "dev"]);

export const socialPlatformEnum = pgEnum("social_platform", [
  "instagram",
  "facebook",
  "linkedin",
  "twitter",
]);

export const socialPostStatusEnum = pgEnum("social_post_status", [
  "draft",
  "pending_approval",
  "approved",
  "published",
  "rejected",
]);

export type LeadStage = (typeof leadStageEnum.enumValues)[number];
export type ChannelType = (typeof channelEnum.enumValues)[number];
export type DirectionType = (typeof directionEnum.enumValues)[number];
export type ServiceType = (typeof serviceTypeEnum.enumValues)[number];
export type OutboxStatus = (typeof outboxStatusEnum.enumValues)[number];
export type TicketSeverity = (typeof ticketSeverityEnum.enumValues)[number];
export type TicketKind = (typeof ticketKindEnum.enumValues)[number];
export type TicketStatus = (typeof ticketStatusEnum.enumValues)[number];
export type ProjectStatus = (typeof projectStatusEnum.enumValues)[number];
export type TaskStatus = (typeof taskStatusEnum.enumValues)[number];
export type TaskKind = (typeof taskKindEnum.enumValues)[number];
export type TaskRunStatus = (typeof taskRunStatusEnum.enumValues)[number];
export type ContractStatus = (typeof contractStatusEnum.enumValues)[number];
export type ApiScope = (typeof apiScopeEnum.enumValues)[number];
export type SocialPlatform = (typeof socialPlatformEnum.enumValues)[number];
export type SocialPostStatus = (typeof socialPostStatusEnum.enumValues)[number];

/* ------------------------------------------------------------------ */
/* Shared column helpers                                               */
/* ------------------------------------------------------------------ */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/* ------------------------------------------------------------------ */
/* Core CRM                                                            */
/* ------------------------------------------------------------------ */

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    name: text("name").notNull(),
    // Dedupe keys. Nullable, but unique when present (Postgres allows many NULLs).
    domain: text("domain"),
    googlePlaceId: text("google_place_id"),
    linkedinUrl: text("linkedin_url"),
    website: text("website"),
    industry: text("industry"),
    city: text("city"),
    country: text("country"),
    // T3 follow-up: when to contact this client next + why.
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    followUpNote: text("follow_up_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("organizations_domain_uq").on(t.domain),
    uniqueIndex("organizations_place_uq").on(t.googlePlaceId),
    uniqueIndex("organizations_linkedin_uq").on(t.linkedinUrl),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
    preferredChannel: channelEnum("preferred_channel"),
    // T3 follow-up per contact (Nivel 1): each person gets their own next action.
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    followUpNote: text("follow_up_note"),
    // Do-not-contact flag. Enforced server-side when creating outbox drafts.
    optOut: boolean("opt_out").notNull().default(false),
    optOutAt: timestamp("opt_out_at", { withTimezone: true }),
    // WhatsApp Business only allows messaging people who consented or wrote first.
    whatsappConsent: boolean("whatsapp_consent").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("contacts_email_uq").on(t.email), index("contacts_org_idx").on(t.organizationId)],
);

export const leads = pgTable(
  "leads",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    stage: leadStageEnum("stage").notNull().default("new"),
    stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }).notNull().defaultNow(),
    // Where it came from: google_maps | web | whatsapp | referral | manual | ...
    source: text("source").notNull(),
    serviceType: serviceTypeEnum("service_type"),
    summary: text("summary"),
    estimatedValueCents: integer("estimated_value_cents"),
    currency: text("currency").notNull().default("USD"),
    lostReason: text("lost_reason"),
    // T3 follow-up: when to contact this lead next + why.
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    followUpNote: text("follow_up_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("leads_stage_idx").on(t.stage), index("leads_org_idx").on(t.organizationId)],
);

export const dossiers = pgTable(
  "dossiers",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    // Structured findings: pains, tech stack, signals, decision makers...
    findings: jsonb("findings").notNull().default({}),
    // Every claim must be traceable: [{ url, retrievedAt, note? }]
    sources: jsonb("sources").notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("dossiers_org_idx").on(t.organizationId)],
);

export const interactions = pgTable(
  "interactions",
  {
    id: id(),
    // T5: polymorphic links — at least one should be set, contact preferred.
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    channel: channelEnum("channel").notNull(),
    direction: directionEnum("direction").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("interactions_lead_idx").on(t.leadId),
    index("interactions_contact_idx").on(t.contactId),
    index("interactions_org_idx").on(t.organizationId),
    index("interactions_ticket_idx").on(t.ticketId),
  ],
);

/**
 * Outreach drafts. Agents may only INSERT rows as `pending_approval`.
 * Only the `owner` scope may move a row to `approved`; the sender only takes `approved`.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    // T6: drafts may target a lead (prospecting) OR an existing client directly.
    // At least one of leadId / organizationId must be set (enforced in domain).
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    // Nullable (S5): first-touch drafts may be addressed to a lead before any
    // contact is verified; approval is blocked until a contact is resolved.
    contactId: uuid("contact_id")
      .references(() => contacts.id, { onDelete: "cascade" }),
    // When the draft notifies a client about a support ticket (e.g. the
    // automatic resolution notice), marks which ticket it belongs to.
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    channel: channelEnum("channel").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    // Why this message, why this angle: reviewed by the owner before approving.
    rationale: text("rationale"),
    status: outboxStatusEnum("status").notNull().default("pending_approval"),
    createdBy: text("created_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    rejectedReason: text("rejected_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("outbox_status_idx").on(t.status)],
);

/* ------------------------------------------------------------------ */
/* Delivery: projects, tasks, support, contracts                       */
/* ------------------------------------------------------------------ */

export const projects = pgTable("projects", {
  id: id(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  status: projectStatusEnum("status").notNull().default("onboarding"),
  repoUrl: text("repo_url"),
  // Where this repo lives on the operator machine that runs the coding agent
  // (the desktop launcher). Absolute path, e.g. /Users/x/workspace/client-app.
  localPath: text("local_path"),
  defaultBranch: text("default_branch").notNull().default("main"),
  // Verification command the agent must run (tests, typecheck) — handed to
  // the coding agent as part of the issue when set.
  testCommand: text("test_command"),
  // Last mechanical folder verification performed by the desktop launcher:
  // { exists, isGit, remoteUrl, remoteMatches, branch, clean, checkedAt, error }.
  folderCheck: jsonb("folder_check"),
  folderVerifiedAt: timestamp("folder_verified_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const milestones = pgTable("milestones", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  dueDate: date("due_date"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  // Agreed price for the milestone, in minor units (e.g. cents). Null =
  // not agreed/recorded: reminders must ask the owner, never guess.
  amountCents: integer("amount_cents"),
  currency: text("currency").notNull().default("USD"),
  createdAt: createdAt(),
});

/** Agent-agnostic on purpose: any coding agent can consume a task through the `dev` scope. */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    milestoneId: uuid("milestone_id").references(() => milestones.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    // The spec handed to the coding agent: acceptance criteria, likely files, tests.
    spec: text("spec"),
    status: taskStatusEnum("status").notNull().default("backlog"),
    assignee: text("assignee"),
    prUrl: text("pr_url"),
    // Verification evidence reported by the coding agent on each advance:
    // what ran (tests, typecheck, build) and the outcome. The pm reviews
    // this — never blind sign-off — before client acceptance.
    resultSummary: text("result_summary"),
    // Correction = fix requested on an existing app (HITL approval flow);
    // feature = regular delivery task (backlog/ready pipeline).
    kind: taskKindEnum("kind").notNull().default("feature"),
    // Originating support ticket for corrections: ties the fix back to the
    // client incident so the ticket auto-resolves when the task completes
    // and the client notification references this work.
    ticketId: uuid("ticket_id").references(() => tickets.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tasks_status_idx").on(t.status), index("tasks_ticket_idx").on(t.ticketId)],
);

/**
 * One row per coding-agent launch (gentle-shell) executed by the desktop
 * launcher: log trail, exit outcome and parsed report for audit + rework.
 */
export const taskRuns = pgTable(
  "task_runs",
  {
    id: id(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    status: taskRunStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    // Absolute path to the full process log on the launcher machine.
    logPath: text("log_path"),
    // Absolute path to the composed issue file handed to the agent.
    issuePath: text("issue_path"),
    branch: text("branch"),
    resultSummary: text("result_summary"),
    prUrl: text("pr_url"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("task_runs_task_idx").on(t.taskId)],
);

export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    kind: ticketKindEnum("kind").notNull().default("support"),
    system: text("system").notNull(),
    severity: ticketSeverityEnum("severity").notNull(),
    status: ticketStatusEnum("status").notNull().default("open"),
    description: text("description").notNull(),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // T3 follow-up: when to ping the client about this ticket + why.
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    followUpNote: text("follow_up_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("tickets_status_idx").on(t.status)],
);

export const contracts = pgTable("contracts", {
  id: id(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  // Always requires a human/lawyer reviewer before leaving `draft`.
  status: contractStatusEnum("status").notNull().default("draft"),
  reviewerNote: text("reviewer_note"),
  voidReason: text("void_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------------------ */
/* Platform                                                            */
/* ------------------------------------------------------------------ */

/** Append-only audit log. Every state change writes a row; metrics are derived from it. */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("events_entity_idx").on(t.entity, t.entityId), index("events_created_idx").on(t.createdAt)],
);

export const dailyReports = pgTable(
  "daily_reports",
  {
    id: id(),
    reportDate: date("report_date").notNull(),
    metrics: jsonb("metrics").notNull(),
    content: text("content").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("daily_reports_date_uq").on(t.reportDate)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    name: text("name").notNull(),
    scope: apiScopeEnum("scope").notNull(),
    // SHA-256 of the key. The plaintext key is shown once at creation and never stored.
    keyHash: text("key_hash").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash)],
);

/** Lets agents retry a write without creating duplicates. */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
    actor: text("actor").notNull(),
    response: jsonb("response").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("idempotency_actor_key_uq").on(t.actor, t.key)],
);

/** Social media marketing posts for Instagram, Facebook, LinkedIn, X */
export const socialPosts = pgTable(
  "social_posts",
  {
    id: id(),
    platform: socialPlatformEnum("platform").notNull(),
    topic: text("topic").notNull(),
    caption: text("caption").notNull(),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    imagePrompt: text("image_prompt"),
    imageUrl: text("image_url"),
    status: socialPostStatusEnum("status").notNull().default("pending_approval"),
    rejectedReason: text("rejected_reason"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    externalPostId: text("external_post_id"),
    externalPostUrl: text("external_post_url"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("social_posts_status_idx").on(t.status), index("social_posts_platform_idx").on(t.platform)],
);

/** Orchestrator chat threads (persistent conversation memory) */
export const estimates = pgTable("estimates", {
  id: id(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  organizationId: uuid("organization_id").references(() => organizations.id, {
    onDelete: "set null",
  }),
  // Service category + complexity mirror the ballpark tool's taxonomy.
  category: text("category").notNull(),
  complexity: text("complexity").notNull(),
  // What was proposed, in the solutions agent's own words.
  scopeSummary: text("scope_summary").notNull(),
  // [{ title, timeframe }] — milestone breakdown with realistic timeframes.
  phases: jsonb("phases").notNull().default([]),
  timelineText: text("timeline_text"),
  // Agreed/quoted money, in minor units. Null = not quoted: never guessed.
  valueCents: integer("value_cents"),
  currency: text("currency").notNull().default("USD"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

export const analystReports = pgTable("analyst_reports", {
  id: id(),
  // Optional analysis window the report covers; null = snapshot "as of now".
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  // The full markdown briefing the analyst produced.
  summary: text("summary").notNull(),
  // Frozen metrics snapshot the briefing was grounded in (conversions, stocks).
  metrics: jsonb("metrics").notNull().default({}),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
});

export const chatThreads = pgTable("chat_threads", {
  id: id(),
  title: text("title").notNull().default("Nueva conversación"),
  // Stable external mapping (e.g. "telegram:<chat_id>"): one persistent
  // thread per external conversation, findable without scanning titles.
  externalKey: text("external_key").unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  eveSessionId: text("eve_session_id"),
});

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant | system
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls"),
    eveEventId: text("eve_event_id"),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_thread_idx").on(t.threadId)],
);

