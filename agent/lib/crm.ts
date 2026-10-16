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
  contact: string;
  system: string;
  severity: "critical" | "major" | "minor";
  kind?: "support" | "info";
  description: string;
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
  };
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
  kind: "lead" | "ticket" | "organization";
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
  contactId: string;
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
    draft: { id: string; status: string };
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
      milestones: Array<{ id: string; title: string; dueDate: string | null; doneAt: string | null }>;
      contracts: Array<{ id: string; title: string; status: string }>;
    }>;
  };
}

export interface CreateProjectParams {
  organizationId: string;
  leadId?: string;
  name: string;
  repoUrl?: string;
  milestonesList?: Array<{ title: string; dueDate?: string }>;
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
  title: string;
  spec: string;
  assignee?: string;
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

