/** Dates the way a person reads them on an issue: exact in a prompt, relative on a card. */

/** "2026-09-22T07:57:11.613Z" → "2026-09-22 07:57 UTC"; "" for no date. */
export function when(iso: string): string {
  const at = new Date(iso);
  if (iso === "" || Number.isNaN(at.getTime())) return "";
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** How long ago, in the one unit that matters: "40s", "12m", "5h", "3d", "7mo". */
export function ago(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (iso === "" || Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

/** "2026-09-24T…" → "24 Sep", which is how a date reads on a card. */
export function shortDate(iso: string): string {
  const at = new Date(iso);
  if (iso === "" || Number.isNaN(at.getTime())) return "";
  return `${at.getUTCDate()} ${at.toLocaleString("en", { month: "short", timeZone: "UTC" })}`;
}
