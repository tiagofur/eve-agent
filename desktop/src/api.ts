// Connection resolution order: localStorage override (set from the in-app
// Connection panel) > build-time Vite env (desktop/.env) > local dev default.
// This lets an installed app switch between local and the online deployment
// without a rebuild.
export const API_BASE =
  localStorage.getItem("CREAPOLIS_API_URL") ||
  import.meta.env.VITE_CRM_API_URL ||
  "http://localhost:8787";
// Never hardcode keys in source: configure via desktop/.env
// (VITE_CRM_OWNER_KEY) or the localStorage overrides.
export const OWNER_KEY =
  localStorage.getItem("CREAPOLIS_OWNER_KEY") ||
  import.meta.env.VITE_CRM_OWNER_KEY ||
  "";

export interface FunnelStage {
  stage: string;
  count: number;
}

export interface FunnelReport {
  funnel: FunnelStage[];
  totalInFunnel: number;
  lostCount: number;
  wonCount: number;
}

export interface DailyMetrics {
  totalLeads: number;
  openTickets: number;
  pendingDraftsApproval: number;
  followUpsOverdue: number;
  generatedAt: string;
}

export interface InteractionItem {
  id: string;
  leadId: string | null;
  organizationId: string | null;
  ticketId: string | null;
  projectId: string | null;
  contactId: string | null;
  channel: string;
  direction: "inbound" | "outbound";
  content: string;
  createdAt: string;
}

export interface FollowUpItem {
  kind: "lead" | "ticket" | "organization" | "contact";
  id: string;
  name: string | null;
  organizationName: string | null;
  detail: string | null;
  nextFollowUpAt: string;
  followUpNote: string | null;
  stage: string | null;
}

export interface LeadItem {
  id: string;
  stage: string;
  stageChangedAt?: string | null;
  source: string;
  serviceType: string | null;
  summary: string | null;
  estimatedValueCents?: number | null;
  currency?: string | null;
  createdAt: string;
  organizationName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  nextFollowUpAt?: string | null;
  followUpNote?: string | null;
}

export interface OutboxDraft {
  id: string;
  leadId: string | null;
  organizationId: string | null;
  organizationName: string | null;
  contactId: string | null;
  channel: string;
  subject: string | null;
  body: string;
  rationale: string | null;
  status: string;
  createdAt: string;
  createdBy: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface TicketItem {
  id: string;
  kind: "support" | "info";
  system: string;
  severity: "critical" | "major" | "minor";
  status: string;
  description: string;
  slaDueAt: string;
  createdAt: string;
  contactName: string | null;
  contactEmail: string | null;
  projectId?: string | null;
  projectName?: string | null;
  nextFollowUpAt?: string | null;
  followUpNote?: string | null;
}

/** Task row from GET /api/projects/:id/tasks — every status, for project history. */
export interface ProjectTaskHistoryItem {
  id: string;
  milestoneId: string | null;
  ticketId: string | null;
  title: string;
  spec: string | null;
  status: string;
  assignee: string | null;
  prUrl: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderCheckData {
  exists: boolean;
  isGit: boolean;
  remoteUrl: string | null;
  remoteMatches: boolean | null;
  branch: string | null;
  clean: boolean | null;
  checkedAt: string;
  error?: string;
}

export interface ProjectItem {
  id: string;
  name: string;
  status: string;
  repoUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
  testCommand: string | null;
  folderCheck: FolderCheckData | null;
  folderVerifiedAt: string | null;
  organizationName: string | null;
  createdAt: string;
}

export interface TaskItem {
  id: string;
  projectId: string;
  projectName: string;
  repoUrl: string | null;
  title: string;
  spec: string;
  status: string;
  assignee: string;
  createdAt: string;
}

export interface TaskRunItem {
  id: string;
  taskId: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  logPath: string | null;
  issuePath: string | null;
  branch: string | null;
  resultSummary: string | null;
  prUrl: string | null;
}

export interface PipelineTaskItem {
  id: string;
  projectId: string;
  milestoneId: string | null;
  title: string;
  spec: string;
  status: string;
  assignee: string;
  kind: "feature" | "correction";
  prUrl: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
  project: {
    name: string | null;
    organizationName: string | null;
    repoUrl: string | null;
    localPath: string | null;
    defaultBranch: string;
    testCommand: string | null;
    folderCheck: FolderCheckData | null;
    folderVerifiedAt: string | null;
  };
  latestRun: TaskRunItem | null;
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OWNER_KEY}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API Error (${res.status}): ${errorText}`);
  }

  return (await res.json()) as T;
}

export interface OrganizationItem {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  city: string | null;
  country: string | null;
  createdAt: string;
  projectCount: number;
  leadCount: number;
  nextFollowUpAt?: string | null;
  followUpNote?: string | null;
}

export interface OrganizationSummary {
  organization: OrganizationItem;
  contacts: Array<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    role: string | null;
    preferredChannel: string | null;
  }>;
  leads: LeadItem[];
  projects: ProjectItem[];
  tickets: TicketItem[];
  dossiers: DossierItem[];
  drafts: OutboxDraft[];
  timeline: TimelineEvent[];
}

export const CONTACT_CHANNELS = ["whatsapp", "email", "telegram", "linkedin", "phone", "web", "other"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** Payload para crear o editar un contacto (los null limpian el campo). */
export interface ContactPayload {
  name: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  preferredChannel?: ContactChannel | null;
}

export interface DossierItem {
  id: string;
  organizationId: string;
  leadId: string | null;
  summary: string;
  findings: Record<string, any>;
  sources: Array<{ url: string; retrievedAt: string; note?: string }>;
  createdBy: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: number;
  entity: string;
  entityId: string;
  action: string;
  actor: string;
  before: any;
  after: any;
  reason: string | null;
  createdAt: string;
}

export interface LeadDetailsResponse {
  lead: LeadItem & {
    organizationDomain: string | null;
    stageChangedAt: string | null;
    contactId: string | null;
    contactRole: string | null;
    contactPreferredChannel: string | null;
  };
  dossiers: DossierItem[];
  drafts: OutboxDraft[];
  timeline: TimelineEvent[];
}

export interface TicketDetailsResponse {
  ticket: TicketItem & {
    resolvedAt: string | null;
    updatedAt: string;
    contactPhone: string | null;
  };
  timeline: TimelineEvent[];
  /** Correction tasks linked to this ticket (newest first). */
  tasks?: ProjectTaskHistoryItem[];
}


export interface ContentPackItem {
  id: string;
  kind: "video" | "carousel" | "image";
  topic: string;
  hook: string | null;
  caption: string;
  captionsByPlatform: Record<string, string> | null;
  hashtags: string[];
  platforms: string[];
  notes: string | null;
  scheduledFor: string | null;
  status: "pending_approval" | "approved" | "rejected";
  rejectedReason: string | null;
  hasCover: boolean;
  approvedAt: string | null;
  downloadedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** ZIP download as blob (needs raw fetch: the JSON helper would parse it). */
export async function fetchContentPackZip(id: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${API_BASE}/api/content-packs/${id}/download`, {
    headers: { Authorization: `Bearer ${OWNER_KEY}` },
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API Error (${res.status}): ${errorText}`);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await res.blob(), filename: match?.[1] ?? `pack-${id.slice(0, 8)}.zip` };
}

/** Cover image as object URL for previews; null when the pack has none. */
export async function fetchContentPackCoverUrl(id: string): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/content-packs/${id}/cover`, {
    headers: { Authorization: `Bearer ${OWNER_KEY}` },
  });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

export const crmApi = {
  getHealth: () => request<{ status: string }>("/health"),
  getDailyMetrics: () => request<{ metrics: DailyMetrics }>("/api/reports/daily"),
  getFunnelReport: () => request<FunnelReport>("/api/reports/funnel"),
  getLeads: () => request<{ leads: LeadItem[] }>("/api/leads"),
  /** Alta manual de un lead desde el desktop (override sin agente). */
  createLead: (data: {
    clientName: string;
    companyName?: string;
    contact?: string;
    serviceType?: "software_development" | "automation" | "ai_implementation" | "consulting";
    projectSummary: string;
    estimatedBudget?: string;
    source?: string;
  }) =>
    request<{ success: boolean; leadId: string; stage: string }>("/api/leads", {
      method: "POST",
      body: JSON.stringify({ ...data, source: data.source ?? "manual_desktop" }),
    }),
  /** Edición manual de los campos del lead (la etapa va por /stage). */
  updateLead: (
    leadId: string,
    data: {
      serviceType?: string | null;
      summary?: string;
      estimatedValueCents?: number | null;
      currency?: string;
    }
  ) =>
    request<{ success: boolean; lead: LeadItem }>(`/api/leads/${leadId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  getOrganizations: () =>
    request<{ organizations: OrganizationItem[] }>("/api/organizations"),
  getOrganizationSummary: (orgId: string) =>
    request<OrganizationSummary>(`/api/organizations/${orgId}/summary`),
  /** Alta manual de una organización. 409 con existingId si el nombre ya existe (dedup normalizado). */
  createOrganization: (data: {
    name: string;
    domain?: string | null;
    website?: string | null;
    industry?: string | null;
    city?: string | null;
    country?: string | null;
  }) =>
    request<{ success: boolean; organization: OrganizationItem }>("/api/organizations", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** Eliminar organización (solo si no tiene proyectos). Cascada leads y contactos. */
  deleteOrganization: (orgId: string) =>
    request<{ success: boolean; removedLeads: number; removedContacts: number }>(
      `/api/organizations/${orgId}`,
      { method: "DELETE" }
    ),
  /** Corrección manual de datos de la empresa desde la ficha 360. */
  updateOrganization: (
    orgId: string,
    data: {
      name?: string;
      domain?: string | null;
      website?: string | null;
      industry?: string | null;
      city?: string | null;
      country?: string | null;
    }
  ) =>
    request<{ success: boolean; organization: OrganizationItem }>(`/api/organizations/${orgId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  /** Añadir un contacto a una organización (ficha 360). */
  createOrgContact: (orgId: string, data: ContactPayload) =>
    request<{ success: boolean; contact: { id: string } }>(`/api/organizations/${orgId}/contacts`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** Editar un contacto (ficha 360 o carátula de lead: el lead une contra esta fila). */
  updateContact: (contactId: string, data: Partial<ContactPayload>) =>
    request<{ success: boolean; contact: { id: string } }>(`/api/contacts/${contactId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  /** Eliminar contacto: leads e interacciones conservan su historial (contact_id → NULL). */
  deleteContact: (contactId: string) =>
    request<{ success: boolean; detachedInteractions: number }>(`/api/contacts/${contactId}`, {
      method: "DELETE",
    }),
  /** Crear y vincular un contacto a un lead que llegó sin verificación. */
  createLeadContact: (leadId: string, data: ContactPayload) =>
    request<{ success: boolean; contact: { id: string } }>(`/api/leads/${leadId}/contact`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  convertLead: (leadId: string, projectName?: string) =>
    request<{ success: boolean; project: ProjectItem }>(`/api/leads/${leadId}/convert`, {
      method: "POST",
      body: JSON.stringify(projectName ? { projectName } : {}),
    }),
  getLeadDetails: (leadId: string) => request<LeadDetailsResponse>(`/api/leads/${leadId}/details`),
  updateLeadStage: (leadId: string, targetStage: string, reason: string, lostReason?: string) =>
    request<{ success: boolean }>(`/api/leads/${leadId}/stage`, {
      method: "PATCH",
      body: JSON.stringify({ targetStage, reason, lostReason }),
    }),
  getPendingDrafts: () => request<{ drafts: OutboxDraft[] }>("/api/outbox/pending"),
  createDraft: (data: {
    leadId?: string;
    organizationId?: string;
    contactId: string;
    channel: string;
    subject?: string;
    body: string;
    rationale?: string;
  }) =>
    request<{ success: boolean; draft: OutboxDraft }>("/api/outbox", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  reviewDraft: (draftId: string, decision: "approved" | "rejected", rejectedReason?: string) =>
    request<{ success: boolean }>(`/api/outbox/${draftId}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, rejectedReason }),
    }),
  getTickets: (status?: string) =>
    request<{ tickets: TicketItem[] }>(
      `/api/tickets${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  /** Eliminar ticket cerrado (los abiertos se rechazan con 409). */
  deleteTicket: (ticketId: string) =>
    request<{ success: boolean }>(`/api/tickets/${ticketId}`, { method: "DELETE" }),
  getTicketDetails: (ticketId: string) =>
    request<TicketDetailsResponse>(`/api/tickets/${ticketId}/details`),
  updateTicketContent: (
    ticketId: string,
    data: {
      description?: string;
      system?: string;
      severity?: "critical" | "major" | "minor";
      kind?: "support" | "info";
      projectId?: string | null;
      reason?: string;
    }
  ) =>
    request<{ success: boolean }>(`/api/tickets/${ticketId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  markOutboxSent: (draftId: string) =>
    request<{ success: boolean }>(`/api/outbox/${draftId}/sent`, {
      method: "POST",
    }),
  getApprovedDrafts: () =>
    request<{
      drafts: Array<{
        id: string;
        ticketId: string | null;
        contactId: string | null;
        channel: string;
        subject: string | null;
        body: string;
        approvedAt: string | null;
        createdBy: string;
        contactName: string | null;
        contactEmail: string | null;
        contactPhone: string | null;
        organizationName: string | null;
      }>;
    }>("/api/outbox/approved"),
  setLeadFollowUp: (leadId: string, nextFollowUpAt: string | null, followUpNote?: string) =>
    request<{ success: boolean }>(`/api/leads/${leadId}/followup`, {
      method: "PATCH",
      body: JSON.stringify({ nextFollowUpAt, followUpNote }),
    }),
  setTicketFollowUp: (ticketId: string, nextFollowUpAt: string | null, followUpNote?: string) =>
    request<{ success: boolean }>(`/api/tickets/${ticketId}/followup`, {
      method: "PATCH",
      body: JSON.stringify({ nextFollowUpAt, followUpNote }),
    }),
  setOrganizationFollowUp: (orgId: string, nextFollowUpAt: string | null, followUpNote?: string) =>
    request<{ success: boolean }>(`/api/organizations/${orgId}/followup`, {
      method: "PATCH",
      body: JSON.stringify({ nextFollowUpAt, followUpNote }),
    }),
  getFollowups: () => request<{ overdue: FollowUpItem[]; upcoming: FollowUpItem[] }>("/api/reports/followups"),
  logInteraction: (data: {
    leadId?: string;
    organizationId?: string;
    ticketId?: string;
    projectId?: string;
    contactId?: string;
    channel: string;
    direction: "inbound" | "outbound";
    content: string;
  }) =>
    request<{ success: boolean; interaction: InteractionItem }>("/api/interactions", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getContactThread: (contactId: string) =>
    request<{
      contact: { id: string; name: string; nextFollowUpAt: string | null; followUpNote: string | null };
      interactions: InteractionItem[];
    }>(`/api/interactions/by-contact/${contactId}`),
  setContactFollowUp: (contactId: string, nextFollowUpAt: string | null, followUpNote?: string) =>
    request<{ success: boolean }>(`/api/contacts/${contactId}/followup`, {
      method: "PATCH",
      body: JSON.stringify({ nextFollowUpAt, followUpNote }),
    }),
  updateTicketStatus: (
    ticketId: string,
    status: string,
    reason?: string,
    clientMessage?: string
  ) =>
    request<{ success: boolean }>(`/api/tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, reason, clientMessage }),
    }),
  getProjects: () => request<{ projects: ProjectItem[] }>("/api/projects"),
  /** Alta manual de un proyecto para un cliente existente (los hitos se agregan después). */
  createProject: (data: { organizationId: string; name: string; repoUrl?: string }) =>
    request<{ success: boolean; project: ProjectItem }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  /** Editar proyecto. Nunca se borra: se cierra (delivered) o cancela (cancelled). */
  updateProject: (
    projectId: string,
    data: {
      name?: string;
      repoUrl?: string | null;
      status?: "onboarding" | "active" | "paused" | "delivered" | "cancelled";
    }
  ) =>
    request<{ success: boolean; project: ProjectItem }>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  getReadyTasks: () => request<{ tasks: TaskItem[] }>("/api/projects/tasks/ready"),
  getPipelineTasks: () =>
    request<{ tasks: PipelineTaskItem[] }>("/api/projects/tasks/pipeline"),
  getProjectTasks: (projectId: string) =>
    request<{ tasks: ProjectTaskHistoryItem[] }>(`/api/projects/${projectId}/tasks`),
  createCorrectionTask: (data: {
    projectId: string;
    title: string;
    spec: string;
    kind?: "feature" | "correction";
    milestoneId?: string;
  }) =>
    request<{ success: boolean; task: { id: string; status: string } }>("/api/projects/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  approveTask: (taskId: string) =>
    request<{ success: boolean }>(`/api/projects/tasks/${taskId}/approve`, {
      method: "POST",
    }),
  rejectTask: (taskId: string, reason?: string) =>
    request<{ success: boolean }>(`/api/projects/tasks/${taskId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  updateTaskStatus: (taskId: string, status: string, extra?: { resultSummary?: string; prUrl?: string }) =>
    request<{ success: boolean }>(`/api/projects/tasks/${taskId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, ...extra }),
    }),
  openTaskRun: (taskId: string, data: { logPath?: string; issuePath?: string; branch?: string }) =>
    request<{ success: boolean; run: TaskRunItem }>(`/api/projects/tasks/${taskId}/runs`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  closeTaskRun: (
    taskId: string,
    runId: string,
    data: { exitCode: number; resultSummary?: string; prUrl?: string }
  ) =>
    request<{ success: boolean }>(`/api/projects/tasks/${taskId}/runs/${runId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  updateProjectFolder: (
    projectId: string,
    data: { localPath?: string | null; defaultBranch?: string; testCommand?: string | null }
  ) =>
    request<{ success: boolean; project: ProjectItem }>(`/api/projects/${projectId}/folder`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  reportFolderCheck: (projectId: string, check: FolderCheckData) =>
    request<{ success: boolean; verified: boolean }>(`/api/projects/${projectId}/folder/verify`, {
      method: "POST",
      body: JSON.stringify({ check }),
    }),
  sendChatMessage: (messages: ChatMessage[], threadId?: string | null) =>
    request<ChatResponse>("/api/chat", {
      method: "POST",
      body: JSON.stringify(threadId ? { messages, threadId } : { messages }),
    }),
  getChatThreads: () => request<{ threads: ChatThread[] }>("/api/chat/threads"),
  createChatThread: (title?: string) =>
    request<{ thread: ChatThread }>("/api/chat/threads", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  getChatThread: (threadId: string) =>
    request<ChatThreadDetails>(`/api/chat/threads/${threadId}`),
  deleteChatThread: (threadId: string) =>
    request<{ success: boolean }>(`/api/chat/threads/${threadId}`, {
      method: "DELETE",
    }),
  getSocialPosts: () => request<{ posts: SocialPostItem[] }>("/api/marketing"),
  getContentPacks: (status?: "pending_approval" | "approved" | "rejected") =>
    request<{ packs: ContentPackItem[] }>(
      `/api/content-packs${status ? `?status=${status}` : ""}`
    ),
  reviewContentPack: (id: string, decision: "approved" | "rejected", rejectedReason?: string) =>
    request<{ success: boolean }>(`/api/content-packs/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, rejectedReason }),
    }),
  generateSocialPost: (data: { platform: string; topic: string; tone?: string }) =>
    request<{ success: boolean; post: SocialPostItem }>("/api/marketing/generate", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  reviewSocialPost: (id: string, decision: "approved" | "rejected", rejectedReason?: string) =>
    request<{ success: boolean }>(`/api/marketing/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, rejectedReason }),
    }),
  publishSocialPost: (id: string) =>
    request<{ success: boolean }>(`/api/marketing/${id}/publish`, {
      method: "POST",
    }),
};

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ChatResponse {
  reply: string;
  threadId?: string;
  toolCalls?: Array<{
    toolName: string;
    args: any;
  }>;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatThreadDetails {
  thread: ChatThread;
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    toolCalls?: Array<{ toolName: string; args: any }> | null;
    createdAt: string;
  }>;
}

export interface SocialPostItem {
  id: string;
  platform: "instagram" | "facebook" | "linkedin" | "twitter";
  topic: string;
  caption: string;
  hashtags: string[];
  imagePrompt: string | null;
  imageUrl: string | null;
  status: "draft" | "pending_approval" | "approved" | "published" | "rejected";
  rejectedReason: string | null;
  publishedAt: string | null;
  externalPostId?: string | null;
  externalPostUrl?: string | null;
  createdBy: string;
  createdAt: string;
}


