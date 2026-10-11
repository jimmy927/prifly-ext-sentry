/**
 * The plain settings, from prifly's Extensions page (`prifly-extension.json`
 * declares them) and nowhere else. An extension cannot write its settings
 * (`api.settings` is read-only; only the Extensions page sets one).
 */

import type { SettingValue } from "./prifly-api";

/** The manifest's defaults for the settings below; a test keeps the two in step. */
export const SETTING_DEFAULTS = {
  org: "",
  baseUrl: "https://sentry.io",
  projectFolders: "",
  query: "is:unresolved",
  period: "14d",
  sort: "date",
  refreshSeconds: 120,
} as const;

export type Values = Readonly<Record<string, SettingValue>>;

/**
 * `slug=folder` pairs, separated by `;` or line breaks. A pair splits at its
 * first `=` only, so a Windows path (`C:\Users\x\src\odi`) keeps its `:` and
 * `\`. A folder may be wrapped in quotes. A pair with no `=`, no slug or no
 * folder is skipped, and a later pair for the same slug wins.
 */
export function parseProjectFolders(text: unknown): Record<string, string> {
  const folders: Record<string, string> = {};
  if (typeof text !== "string") return folders;
  for (const pair of text.split(/[;\r\n]+/)) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const slug = pair.slice(0, at).trim();
    const folder = pair
      .slice(at + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2")
      .trim();
    if (slug !== "" && folder !== "") folders[slug] = folder;
  }
  return folders;
}

/**
 * The settings as the plain object `parseConfig` reads, which fills in the
 * defaults for what is empty or mistyped. The `projectFolders` pairs become
 * `projects`.
 */
export function settingsRaw(values: Values): Record<string, unknown> {
  return {
    org: text(values["org"]),
    baseUrl: text(values["baseUrl"]),
    period: text(values["period"]),
    sort: values["sort"],
    query: text(values["query"]),
    refreshSeconds: values["refreshSeconds"],
    projects: parseProjectFolders(values["projectFolders"]),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}
