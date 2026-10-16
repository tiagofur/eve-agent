/**
 * Google Calendar integration for the Creapolis.Dev eve agent.
 *
 * Pure `fetch` against the public REST API — no googleapis dependency.
 * Credentials always come from the environment at call time (never committed):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
 *   GOOGLE_CALENDAR_ID (optional, defaults to "primary").
 * The one-time consent that mints the refresh token lives in
 * `scripts/google-auth.mjs` (same pattern as `scripts/meta-login.mjs`).
 *
 * Timezone policy: America/Costa_Rica is UTC-6 year-round (no DST), so
 * RFC3339 timestamps are built with a fixed -06:00 offset.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const CALENDAR_ID_DEFAULT = "primary";
const COSTA_RICA_TZ = "America/Costa_Rica";
const COSTA_RICA_OFFSET = "-06:00";
const FETCH_TIMEOUT_MS = 15_000;
const CONSULT_MINUTES = 30;
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;

export interface GoogleCalendarEnv {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
}

export function readCalendarEnv(): GoogleCalendarEnv | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return {
    clientId,
    clientSecret,
    refreshToken,
    calendarId: process.env.GOOGLE_CALENDAR_ID?.trim() || CALENDAR_ID_DEFAULT,
  };
}

export function setupHint(): string {
  return (
    "Google Calendar no configurado. El dueño debe: 1) crear un OAuth client " +
    "de tipo Desktop en Google Cloud con la Calendar API habilitada, 2) correr " +
    "`node scripts/google-auth.mjs` y aprobar el consentimiento una vez, " +
    "3) guardar GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REFRESH_TOKEN " +
    "en el .env del servicio (opcional GOOGLE_CALENDAR_ID, default primary). " +
    "Ver docs/OPERATIONS_RUNBOOK.md."
  );
}

async function postJson(
  url: string,
  init: { headers?: Record<string, string>; body?: string; form?: Record<string, string> }
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  } else {
    headers["Content-Type"] = "application/json";
    body = init.body;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = (await response.json().catch(() => null)) as unknown;
  return { status: response.status, json };
}

export async function refreshAccessToken(env: GoogleCalendarEnv): Promise<string> {
  const { status, json } = await postJson(TOKEN_URL, {
    form: {
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: env.refreshToken,
      grant_type: "refresh_token",
    },
  });
  const data = (json ?? {}) as Record<string, unknown>;
  if (status !== 200 || typeof data.access_token !== "string") {
    const code = typeof data.error === "string" ? data.error : `HTTP ${status}`;
    const needsConsent =
      code === "invalid_grant" ? " El refresh token fue revocado o expiró: repite el consentimiento con `node scripts/google-auth.mjs`." : "";
    throw new Error(`No se pudo renovar el acceso a Google (${code}).${needsConsent}`);
  }
  return data.access_token;
}

export interface SlotInput {
  preferredDate?: string;
  preferredTimeSlot?: string;
}

export interface ResolvedSlot {
  startRfc3339: string;
  endRfc3339: string;
  humanEs: string;
}

const DAY_NAMES: Record<string, number> = {
  domingo: 0, sunday: 0, dom: 0, sun: 0,
  lunes: 1, monday: 1, lun: 1, mon: 1,
  martes: 2, tuesday: 2, mar: 2, tue: 2, tues: 2,
  miercoles: 3, miércoles: 3, wednesday: 3, mie: 3, wed: 3,
  jueves: 4, thursday: 4, jue: 4, thu: 4, thur: 4, thurs: 4,
  viernes: 5, friday: 5, vie: 5, fri: 5,
  sabado: 6, sábado: 6, saturday: 6, sab: 6, sat: 6,
};

const PART_OF_DAY: Array<[RegExp, number, number, string]> = [
  [/mañana|morning|am\b.*temprano/i, 9, 0, "por la mañana"],
  [/mediod[ií]a|midday|noon/i, 12, 0, "al mediodía"],
  [/tarde|afternoon|siesta/i, 15, 0, "por la tarde"],
  [/noche|evening|night/i, 18, 0, "por la noche"],
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toLocalYMD(d: Date): string {
  // Costa Rica wall-clock date from a UTC instant (fixed -06:00, no DST).
  const shifted = new Date(d.getTime() - 6 * 3_600_000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function addDaysYMD(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  // Pure UTC-midnight arithmetic: exact across month/year boundaries, no offsets needed.
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function weekdayOfYMD(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  // Noon UTC is safely inside the CR calendar day.
  return new Date(Date.UTC(y, m - 1, d, 18, 0, 0)).getUTCDay();
}

function parseTimeToHM(raw: string): { h: number; m: number } | null {
  const text = raw.trim().toLowerCase().replace(/\./g, "");
  const ampm = text.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\s?m\b/);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2] ?? "0");
    const pm = ampm[3] === "p";
    if (h < 1 || h > 12 || m > 59) return null;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return { h, m };
  }
  const hm = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h > 23 || m > 59) return null;
    return { h, m };
  }
  return null;
}

/** Resolve natural-language date/time into a concrete 30-min slot. Never invents: throws when unclear. */
export function parseSlotInput(input: SlotInput, now: Date = new Date()): ResolvedSlot {
  const combined = `${input.preferredDate ?? ""} ${input.preferredTimeSlot ?? ""}`.trim();
  if (!combined) {
    throw new Error(
      "Falta fecha y hora: pide algo como 2026-10-20 + 10:00 AM (América/Costa_Rica). Nunca invento horarios."
    );
  }
  const lower = combined.toLowerCase();
  const todayYMD = toLocalYMD(now);

  let ymd: string | null = null;
  const iso = lower.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    ymd = `${iso[1]}-${iso[2]}-${iso[3]}`;
  } else if (/\bhoy\b|\btoday\b/.test(lower)) {
    ymd = todayYMD;
  } else if (/\bmañana\b|\btomorrow\b/.test(lower)) {
    ymd = addDaysYMD(todayYMD, 1);
  } else {
    for (const [name, weekday] of Object.entries(DAY_NAMES)) {
      if (lower.includes(name)) {
        let delta = (weekday - weekdayOfYMD(todayYMD) + 7) % 7;
        if (delta === 0) delta = 7; // next occurrence, strictly in the future
        ymd = addDaysYMD(todayYMD, delta);
        break;
      }
    }
  }
  if (!ymd) {
    throw new Error(
      `No entendí la fecha en "${combined}": pide un día concreto (YYYY-MM-DD, día de semana, hoy o mañana).`
    );
  }

  let hm = parseTimeToHM(combined);
  let partLabel = "";
  if (!hm) {
    for (const [re, h, m, label] of PART_OF_DAY) {
      if (re.test(combined)) {
        hm = { h, m };
        partLabel = ` ${label}`;
        break;
      }
    }
  }
  if (!hm) hm = { h: 10, m: 0 }; // default business-morning slot

  const startRfc3339 = `${ymd}T${pad(hm.h)}:${pad(hm.m)}:00${COSTA_RICA_OFFSET}`;
  const endMinutes = hm.h * 60 + hm.m + CONSULT_MINUTES;
  const endRfc3339 = `${ymd}T${pad(Math.floor(endMinutes / 60) % 24)}:${pad(endMinutes % 60)}:00${COSTA_RICA_OFFSET}`;

  if (new Date(startRfc3339).getTime() <= now.getTime()) {
    throw new Error(`El horario ${ymd} ${pad(hm.h)}:${pad(hm.m)} ya pasó: propone otro en el futuro.`);
  }
  return { startRfc3339, endRfc3339, humanEs: `${ymd} ${pad(hm.h)}:${pad(hm.m)}${partLabel} (América/Costa_Rica)` };
}

export function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

interface BusyRange {
  start: string;
  end: string;
}

function overlaps(aStart: number, aEnd: number, b: BusyRange): boolean {
  return aStart < new Date(b.end).getTime() && new Date(b.start).getTime() < aEnd;
}

/** Pure: free 30-min slots (HH:MM) inside business hours given busy ranges. */
export function findFreeSlots(
  ymd: string,
  busy: BusyRange[],
  count = 3,
  startHour = BUSINESS_START_HOUR,
  endHour = BUSINESS_END_HOUR
): string[] {
  const free: string[] = [];
  for (let h = startHour; h < endHour && free.length < count; h++) {
    for (const m of [0, 30]) {
      const s = new Date(`${ymd}T${pad(h)}:${pad(m)}:00${COSTA_RICA_OFFSET}`).getTime();
      const e = s + CONSULT_MINUTES * 60_000;
      if (!busy.some((b) => overlaps(s, e, b))) free.push(`${pad(h)}:${pad(m)}`);
      if (free.length >= count) break;
    }
  }
  return free;
}

export async function queryBusy(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<BusyRange[]> {
  const response = await fetch(FREEBUSY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      timeZone: COSTA_RICA_TZ,
      items: [{ id: calendarId }],
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`FreeBusy respondió HTTP ${response.status}. Revisa GOOGLE_CALENDAR_ID y permisos.`);
  }
  const data = (await response.json().catch(() => null)) as {
    calendars?: Record<string, { busy?: BusyRange[] }>;
  } | null;
  return data?.calendars?.[calendarId]?.busy ?? [];
}

export interface ConsultationInput {
  clientName: string;
  contact?: string;
  discussionTopics: string[];
  preferredDate?: string;
  preferredTimeSlot?: string;
  now?: Date;
}

export interface ConsultationResult {
  ok: boolean;
  status: "scheduled" | "needs_new_slot" | "not_configured" | "failed";
  message: string;
  eventId?: string;
  eventLink?: string;
  meetLink?: string;
  when?: string;
  alternatives?: string[];
}

function randomRequestId(): string {
  return `creapolis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function scheduleConsultation(
  input: ConsultationInput,
  env: GoogleCalendarEnv | null = readCalendarEnv()
): Promise<ConsultationResult> {
  if (!env) {
    return { ok: false, status: "not_configured", message: setupHint() };
  }

  let slot: ResolvedSlot;
  try {
    slot = parseSlotInput(
      { preferredDate: input.preferredDate, preferredTimeSlot: input.preferredTimeSlot },
      input.now ?? new Date()
    );
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      message: err instanceof Error ? err.message : "Fecha/hora no válida.",
    };
  }

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(env);
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      message: err instanceof Error ? err.message : "Fallo de autenticación con Google.",
    };
  }

  let busy: BusyRange[];
  try {
    busy = await queryBusy(accessToken, env.calendarId, slot.startRfc3339, slot.endRfc3339);
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      message: err instanceof Error ? err.message : "No se pudo revisar disponibilidad.",
    };
  }
  if (busy.length > 0) {
    const ymd = slot.startRfc3339.slice(0, 10);
    let dayBusy: BusyRange[] = [];
    try {
      dayBusy = await queryBusy(
        accessToken,
        env.calendarId,
        `${ymd}T${pad(BUSINESS_START_HOUR)}:00:00${COSTA_RICA_OFFSET}`,
        `${ymd}T${pad(BUSINESS_END_HOUR)}:00:00${COSTA_RICA_OFFSET}`
      );
    } catch {
      dayBusy = [];
    }
    return {
      ok: false,
      status: "needs_new_slot",
      message: `Ese horario (${slot.humanEs}) está ocupado en el calendario. Propón otro.`,
      alternatives: findFreeSlots(ymd, dayBusy, 3),
    };
  }

  const attendee =
    input.contact && isEmailLike(input.contact) ? input.contact.trim() : undefined;
  const description = [
    `Consulta de descubrimiento Creapolis.Dev (30 min) con ${input.clientName}.`,
    input.contact ? `Contacto: ${input.contact}.` : null,
    input.discussionTopics.length > 0 ? `Temas: ${input.discussionTopics.join("; ")}.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const createUrl =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.calendarId)}` +
    `/events?conferenceDataVersion=1&sendUpdates=all`;
  let created: {
    id?: unknown;
    htmlLink?: unknown;
    hangoutLink?: unknown;
  };
  try {
    const response = await fetch(createUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        summary: `Descubrimiento Creapolis.Dev — ${input.clientName}`,
        description,
        start: { dateTime: slot.startRfc3339, timeZone: COSTA_RICA_TZ },
        end: { dateTime: slot.endRfc3339, timeZone: COSTA_RICA_TZ },
        ...(attendee ? { attendees: [{ email: attendee }] } : {}),
        conferenceData: {
          createRequest: {
            requestId: randomRequestId(),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    created = (await response.json().catch(() => null)) as typeof created;
    if (!response.ok || typeof created?.id !== "string") {
      throw new Error(`Calendar respondió HTTP ${response.status}. Revisa permisos de escritura.`);
    }
  } catch (err) {
    return {
      ok: false,
      status: "failed",
      message: err instanceof Error ? err.message : "No se pudo crear el evento.",
    };
  }

  const meet =
    typeof created.hangoutLink === "string" && created.hangoutLink
      ? created.hangoutLink
      : "Link Meet en el evento de calendario.";
  return {
    ok: true,
    status: "scheduled",
    message:
      `Consulta agendada para ${slot.humanEs} con link Meet.` +
      (attendee ? ` Invitación enviada a ${attendee}.` : " Sin email: avisa al contacto manualmente."),
    eventId: created.id,
    eventLink: typeof created.htmlLink === "string" ? created.htmlLink : undefined,
    meetLink: meet,
    when: slot.humanEs,
  };
}
