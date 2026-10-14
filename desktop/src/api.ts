export const API_BASE = import.meta.env.VITE_CRM_API_URL || "http://localhost:8787";
// Configure via desktop/.env (VITE_CRM_OWNER_KEY) or localStorage override.
// Never hardcode keys in source.
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
  generatedAt: string;
}

export interface LeadItem {
  id: string;
  stage: string;
  source: string;
  serviceType: string | null;
  summary: string | null;
  createdAt: string;
  organizationName: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

export interface OutboxDraft {
  id: string;
  leadId: string;
  contactId: string;
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
  system: string;
  severity: "critical" | "major" | "minor";
  status: string;
  description: string;
  slaDueAt: string;
  createdAt: string;
  contactName: string | null;
  contactEmail: string | null;
}

export interface ProjectItem {
  id: string;
  name: string;
  status: string;
  repoUrl: string | null;
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
}

export const crmApi = {
  getHealth: () => request<{ status: string }>("/health"),
  getDailyMetrics: () => request<{ metrics: DailyMetrics }>("/api/reports/daily"),
  getFunnelReport: () => request<FunnelReport>("/api/reports/funnel"),
  getLeads: () => request<{ leads: LeadItem[] }>("/api/leads"),
  getLeadDetails: (leadId: string) => request<LeadDetailsResponse>(`/api/leads/${leadId}/details`),
  updateLeadStage: (leadId: string, targetStage: string, reason: string, lostReason?: string) =>
    request<{ success: boolean }>(`/api/leads/${leadId}/stage`, {
      method: "PATCH",
      body: JSON.stringify({ targetStage, reason, lostReason }),
    }),
  getPendingDrafts: () => request<{ drafts: OutboxDraft[] }>("/api/outbox/pending"),
  reviewDraft: (draftId: string, decision: "approved" | "rejected", rejectedReason?: string) =>
    request<{ success: boolean }>(`/api/outbox/${draftId}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, rejectedReason }),
    }),
  getTickets: () => request<{ tickets: TicketItem[] }>("/api/tickets"),
  getTicketDetails: (ticketId: string) =>
    request<TicketDetailsResponse>(`/api/tickets/${ticketId}/details`),
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
  getReadyTasks: () => request<{ tasks: TaskItem[] }>("/api/projects/tasks/ready"),
  sendChatMessage: (messages: ChatMessage[]) =>
    request<ChatResponse>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ messages }),
    }),
  getSocialPosts: () => request<{ posts: SocialPostItem[] }>("/api/marketing"),
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
  toolCalls?: Array<{
    toolName: string;
    args: any;
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


