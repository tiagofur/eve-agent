/**
 * Local wall-clock formatting for <input type="datetime-local">.
 *
 * CRM API timestamps are UTC instants (RFC3339 ending in "Z"). A
 * datetime-local input value carries NO offset: the browser always renders
 * it as the operator's local wall time. Feeding it `iso.slice(0, 16)` shows
 * UTC as if it were local — a follow-up an agent scheduled for 8:00 am
 * (2026-10-20T13:00:00.000Z) displayed as 1:00 pm for a UTC-5 operator
 * (support ticket 0659d873). Convert the instant through local Date getters
 * instead.
 */

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format an instant as the LOCAL "YYYY-MM-DDTHH:MM" a datetime-local input expects. */
export function toLocalInputValue(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/** Parse an API timestamp (any RFC3339 offset) into local wall time; "" when unparseable. */
export function apiIsoToLocalInputValue(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : toLocalInputValue(d);
}
