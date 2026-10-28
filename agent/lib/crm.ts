/**
 * Creapolis CRM HTTP client.
 * Calls the CRM API server running on CRM_API_URL using scoped keys.
 */

const getCrmUrl = () => process.env.CRM_API_URL ?? "http://localhost:8787";

/**
 * Scoped CRM keys are required configuration; never hardcoded.
 * Copy .env.example to .env.local and fill them in.
 */
const requireKey = (name: "CRM_FRONT_KEY" | "CRM_OPS_KEY"): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured. Copy .env.example to .env.local and set it.`);
  }
  return value;
};

const getFrontKey = () => requireKey("CRM_FRONT_KEY");
const getOpsKey = () => requireKey("CRM_OPS_KEY");

export interface RegisterLeadParams {
  clientName: string;
  companyName?: string;
  contact?: string;
  serviceType?: "software_development" | "automation" | "ai_implementation" | "consulting";
  projectSummary: string;
  estimatedBudget?: string;
  source?: string;
}

export async function crmRegisterLead(data: RegisterLeadParams) {
  const res = await fetch(`${getCrmUrl()}/api/leads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getFrontKey()}`,
    },
    body: JSON.stringify({
      ...data,
      source: data.source ?? "front_agent",
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM lead registration failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    leadId: string;
    contactId?: string;
    stage: string;
    hasOptOut: boolean;
    recordedAt: string;
  };
}

export interface CreateSupportTicketParams {
  clientName: string;
  companyName?: string;
  contact?: string;
  system: string;
  severity?: "critical" | "major" | "minor";
  kind?: "support" | "info";
  description: string;
  /** Affected client project, when known — ties the ticket to its system. */
  projectId?: string;
}

export async function crmCreateTicket(data: CreateSupportTicketParams) {
  const res = await fetch(`${getCrmUrl()}/api/tickets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getFrontKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM ticket creation failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    ticketId: string;
    kind: string;
    severity: string;
    slaDueAt: string;
    slaHours: number;
    status: string;
    duplicate: boolean;
  };
}

export interface CrmTicketItem {
  id: string;
  kind: string;
  system: string;
  severity: string;
  status: string;
  description: string;
  slaDueAt: string;
  projectId: string | null;
  projectName: string | null;
  createdAt: string;
  contactName: string | null;
  contactEmail: string | null;
}

export async function crmGetTickets(status?: string): Promise<{ tickets: CrmTicketItem[] }> {
  const url = new URL(`${getCrmUrl()}/api/tickets`);
  if (status) url.searchParams.set("status", status);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${getOpsKey()}` },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM ticket list failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { tickets: CrmTicketItem[] };
}

export interface UpdateTicketContentParams {
  description?: string;
  system?: string;
  severity?: "critical" | "major" | "minor";
  kind?: "support" | "info";
  projectId?: string | null;
  reason?: string;
}

export async function crmUpdateTicketContent(ticketId: string, data: UpdateTicketContentParams) {
  const res = await fetch(`${getCrmUrl()}/api/tickets/${ticketId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM ticket update failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { success: boolean; ticket: { id: string; status: string } };
}

export async function crmUpdateTicketStatus(
  ticketId: string,
  status: "open" | "in_progress" | "waiting_client" | "resolved" | "closed",
  extra?: { reason?: string; clientMessage?: string }
) {
  const res = await fetch(`${getCrmUrl()}/api/tickets/${ticketId}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify({ status, ...extra }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM ticket status change failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { success: boolean; ticket: { id: string; status: string } };
}

export interface LogInteractionParams {
  leadId?: string;
  organizationId?: string;
  ticketId?: string;
  projectId?: string;
  contactId?: string;
  channel: "whatsapp" | "email" | "telegram" | "linkedin" | "phone" | "web" | "other";
  direction: "inbound" | "outbound";
  content: string;
}

export async function crmLogInteraction(data: LogInteractionParams) {
  const res = await fetch(`${getCrmUrl()}/api/interactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM interaction log failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    interaction: { id: string; createdAt: string };
  };
}

export interface SaveDossierParams {
  leadId?: string;
  organizationId?: string;
  companyName?: string;
  domain?: string;
  googlePlaceId?: string;
  summary: string;
  findings: Record<string, unknown>;
  sources: Array<{ url: string; retrievedAt: string; note?: string }>;
  contact?: { name?: string; email?: string; phone?: string };
}

export async function crmSaveDossier(data: SaveDossierParams) {
  const res = await fetch(`${getCrmUrl()}/api/dossiers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM dossier creation failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    dossier: {
      id: string;
      organizationId: string;
      leadId: string | null;
      summary: string;
      createdAt: string;
    };
  };
}

export async function crmGetFunnelMetrics() {
  const res = await fetch(`${getCrmUrl()}/api/reports/funnel`, {
    headers: {
      Authorization: `Bearer ${getOpsKey()}`,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM funnel report failed (${res.status}): ${errorText}`);
  }

  return await res.json();
}

export interface FollowUpQueueItem {
  kind: "lead" | "ticket" | "organization" | "contact";
  id: string;
  name: string | null;
  organizationName: string | null;
  detail: string | null;
  nextFollowUpAt: string;
  followUpNote: string | null;
  stage: string | null;
}

export async function crmGetFollowups() {
  const res = await fetch(`${getCrmUrl()}/api/reports/followups`, {
    headers: {
      Authorization: `Bearer ${getOpsKey()}`,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM followups report failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    overdue: FollowUpQueueItem[];
    upcoming: FollowUpQueueItem[];
  };
}

export interface CreateDraftParams {
  leadId?: string;
  organizationId?: string;
  contactId?: string;
  channel: "email" | "linkedin" | "whatsapp" | "phone" | "telegram" | "web" | "other";
  subject?: string;
  body: string;
  rationale?: string;
}

export async function crmCreateDraft(data: CreateDraftParams) {
  const res = await fetch(`${getCrmUrl()}/api/outbox`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM draft creation failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    draft: { id: string; status: string; contactId: string | null };
    contactResolution?: "explicit" | "lead" | "missing";
  };
}

export async function crmGetBilling() {
  const res = await fetch(`${getCrmUrl()}/api/projects/billing`, {
    headers: {
      Authorization: `Bearer ${getOpsKey()}`,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM billing report failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    projects: Array<{
      id: string;
      name: string;
      status: string;
      organizationId: string;
      organizationName: string | null;
      milestones: Array<{
        id: string;
        title: string;
        dueDate: string | null;
        doneAt: string | null;
        amountCents: number | null;
        currency: string;
      }>;
      contracts: Array<{ id: string; title: string; status: string }>;
      overdueMilestones: Array<{
        id: string;
        title: string;
        dueDate: string | null;
        doneAt: string | null;
        amountCents: number | null;
        currency: string;
      }>;
      dueSoonMilestones: Array<{
        id: string;
        title: string;
        dueDate: string | null;
        doneAt: string | null;
        amountCents: number | null;
        currency: string;
      }>;
      unsignedContracts: Array<{ id: string; title: string; status: string }>;
    }>;
  };
}

export interface CreateProjectParams {
  organizationId: string;
  leadId?: string;
  name: string;
  repoUrl?: string;
  milestonesList?: Array<{ title: string; dueDate?: string; amountCents?: number; currency?: string }>;
}

export async function crmCreateProject(data: CreateProjectParams) {
  const res = await fetch(`${getCrmUrl()}/api/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM project creation failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    project: {
      id: string;
      name: string;
      status: string;
      repoUrl: string | null;
      createdAt: string;
    };
  };
}

export interface CreateTaskParams {
  projectId: string;
  milestoneId?: string;
  /** Originating support ticket — required gate for corrections. */
  ticketId?: string;
  title: string;
  spec: string;
  assignee?: string;
  kind?: "feature" | "correction";
}

export async function crmCreateTask(data: CreateTaskParams) {
  const res = await fetch(`${getCrmUrl()}/api/projects/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM task dispatch failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    task: {
      id: string;
      projectId: string;
      title: string;
      spec: string;
      status: string;
      assignee: string;
      kind: string;
      createdAt: string;
    };
  };
}

export interface GenerateMarketingPostParams {
  platform: "instagram" | "facebook" | "linkedin" | "twitter";
  topic: string;
  tone?: string;
  targetAudience?: string;
}

export async function crmGenerateMarketingPost(data: GenerateMarketingPostParams) {
  const res = await fetch(`${getCrmUrl()}/api/marketing/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Marketing post generation failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    post: {
      id: string;
      platform: string;
      topic: string;
      caption: string;
      hashtags: string[];
      imagePrompt: string | null;
      status: string;
      createdAt: string;
    };
  };
}


const FOLLOWUP_PATHS = {
  lead: "leads",
  ticket: "tickets",
  organization: "organizations",
  contact: "contacts",
} as const;

export type FollowupEntity = keyof typeof FOLLOWUP_PATHS;

export interface SetFollowupParams {
  entity: FollowupEntity;
  id: string;
  /** ISO datetime with offset to reschedule, or null to clear the reminder. */
  nextFollowUpAt: string | null;
  followUpNote?: string;
}

export async function crmSetFollowup(data: SetFollowupParams) {
  const res = await fetch(`${getCrmUrl()}/api/${FOLLOWUP_PATHS[data.entity]}/${data.id}/followup`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify({
      nextFollowUpAt: data.nextFollowUpAt,
      followUpNote: data.followUpNote,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM follow-up update failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { success: boolean };
}

export interface ConversionEdge {
  from: string;
  to: string;
  count: number;
  rate: number;
}

export interface ConversionsReport {
  sampleSize: number;
  minSample: number;
  sufficientData: boolean;
  entries: Record<string, number>;
  edges: ConversionEdge[];
  medianMsInStage: Record<string, number>;
  lossReasons: Array<{ reason: string; count: number }>;
}

export async function crmGetConversions(): Promise<ConversionsReport> {
  const res = await fetch(`${getCrmUrl()}/api/reports/conversions`, {
    headers: {
      Authorization: `Bearer ${getOpsKey()}`,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM conversions report failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as ConversionsReport;
}

export interface SaveAnalystReportParams {
  summary: string;
  metrics?: Record<string, unknown>;
  periodStart?: string;
  periodEnd?: string;
  createdBy: string;
}

export async function crmSaveAnalystReport(data: SaveAnalystReportParams) {
  const res = await fetch(`${getCrmUrl()}/api/reports/analyst`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM analyst report save failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as {
    success: boolean;
    report: { id: string; summary: string; createdAt: string };
  };
}

export interface AnalystReportItem {
  id: string;
  periodStart: string | null;
  periodEnd: string | null;
  summary: string;
  metrics: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
}

export async function crmGetAnalystReports(limit = 10): Promise<{ reports: AnalystReportItem[] }> {
  const res = await fetch(`${getCrmUrl()}/api/reports/analyst?limit=${limit}`, {
    headers: {
      Authorization: `Bearer ${getOpsKey()}`,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM analyst reports fetch failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { reports: AnalystReportItem[] };
}

export type EstimateCategory =
  | "web_mobile_app"
  | "workflow_automation"
  | "enterprise_ai_agent"
  | "full_system_integration";
export type EstimateComplexity = "mvp" | "standard" | "enterprise";

export interface SaveEstimateParams {
  leadId?: string;
  organizationId?: string;
  category: EstimateCategory;
  complexity: EstimateComplexity;
  scopeSummary: string;
  phases?: Array<{ title: string; timeframe?: string }>;
  timelineText?: string;
  /** Agreed/quoted money in minor units. Omit when not quoted — never guess. */
  valueCents?: number;
  currency?: string;
  createdBy: string;
}

export interface SavedEstimate {
  id: string;
  leadId: string | null;
  organizationId: string | null;
  category: string;
  complexity: string;
  scopeSummary: string;
  phases: Array<{ title: string; timeframe?: string }>;
  timelineText: string | null;
  valueCents: number | null;
  currency: string;
  createdBy: string;
  createdAt: string;
}

export async function crmSaveEstimate(data: SaveEstimateParams) {
  const res = await fetch(`${getCrmUrl()}/api/estimates`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM estimate save failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { success: boolean; estimate: SavedEstimate };
}

export async function crmGetEstimates(params: {
  leadId?: string;
  organizationId?: string;
  limit?: number;
}): Promise<{ estimates: SavedEstimate[] }> {
  const query = new URLSearchParams();
  if (params.leadId) query.set("leadId", params.leadId);
  if (params.organizationId) query.set("organizationId", params.organizationId);
  if (params.limit) query.set("limit", String(params.limit));
  const qs = query.toString();

  const res = await fetch(`${getCrmUrl()}/api/estimates${qs ? `?${qs}` : ""}`, {
    headers: {
      Authorization: `Bearer ${getOpsKey()}`,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM estimates fetch failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { estimates: SavedEstimate[] };
}

export type ContractStatus = "draft" | "in_review" | "sent" | "signed" | "void";

export interface SaveContractParams {
  leadId?: string;
  projectId?: string;
  title: string;
  body: string;
  reviewerNote?: string;
  createdBy: string;
}

export interface SavedContract {
  id: string;
  leadId: string | null;
  projectId: string | null;
  title: string;
  body: string;
  status: ContractStatus;
  reviewerNote: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function crmSaveContract(data: SaveContractParams) {
  const res = await fetch(`${getCrmUrl()}/api/contracts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM contract save failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { success: boolean; contract: SavedContract };
}

export async function crmMoveContract(data: {
  contractId: string;
  status: ContractStatus;
  reason?: string;
  reviewerNote?: string;
}) {
  const res = await fetch(`${getCrmUrl()}/api/contracts/${data.contractId}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpsKey()}`,
    },
    body: JSON.stringify({
      status: data.status,
      reason: data.reason,
      reviewerNote: data.reviewerNote,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM contract move failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { success: boolean; contract: SavedContract };
}

export interface ProjectTaskItem {
  id: string;
  milestoneId: string | null;
  title: string;
  spec: string | null;
  status: string;
  assignee: string | null;
  prUrl: string | null;
  resultSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrmProjectItem {
  id: string;
  name: string;
  status: string;
  repoUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
  testCommand: string | null;
  organizationName: string | null;
  createdAt: string;
}

export async function crmListProjects(): Promise<{ projects: CrmProjectItem[] }> {
  const res = await fetch(`${getCrmUrl()}/api/projects`, {
    headers: {
      Authorization: `Bearer ${getOpsKey()}`,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM project list fetch failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { projects: CrmProjectItem[] };
}

export async function crmGetProjectTasks(projectId: string): Promise<{ tasks: ProjectTaskItem[] }> {
  const res = await fetch(`${getCrmUrl()}/api/projects/${projectId}/tasks`, {
    headers: {
      Authorization: `Bearer ${getOpsKey()}`,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`CRM project tasks fetch failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as { tasks: ProjectTaskItem[] };
}
