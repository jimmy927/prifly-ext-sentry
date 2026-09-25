/**
 * Reading what Sentry sends, tolerantly.
 *
 * Sentry's JSON is wide, changes between releases, and carries `null` where a
 * field has nothing to say. Everything this extension shows is read through
 * these four, so a missing or retyped field becomes "" or 0 or an empty list
 * rather than an exception that blanks the chooser.
 */

export type Json = Record<string, unknown>;

export function obj(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A string as a string, a number or boolean as its text, anything else as "". */
export function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Sentry writes counts as strings ("84") in some places and numbers in others. */
export function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(str(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A value in a line of text: strings as they are, everything else as compact JSON. */
export function brief(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return clip(text, max);
}

/** At most `max` characters, with an ellipsis when something was cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
