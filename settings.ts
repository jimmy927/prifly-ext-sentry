/**
 * The plain settings, from prifly's Extensions page where prifly keeps
 * extension settings (`prifly-extension.json` declares them), over what
 * `config.json` holds.
 *
 * An extension cannot write its settings (`api.settings` is read-only; only
 * the Extensions page sets one), so `config.json` is never imported into
 * them. Instead, per key: a setting that is not at its default wins; a
 * setting still at its default lets `config.json`'s value through. A prifly
 * without settings never gets here and reads `config.json` alone.
 */

import type { SettingValue } from "./prifly-api";
import { obj } from "./read";

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

type Values = Readonly<Record<string, SettingValue>>;

/** The string keys that are one text each; `config.json` calls them by the same name. */
const TEXT_KEYS = ["org", "baseUrl", "period", "sort"] as const;

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

/** What the reader typed for a text setting, or null while it is empty or at its default. */
function chosen(values: Values, key: keyof typeof SETTING_DEFAULTS): string | null {
  const value = values[key];
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || text === SETTING_DEFAULTS[key] ? null : text;
}

function chosenRefresh(values: Values): number | null {
  const value = values["refreshSeconds"];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value !== SETTING_DEFAULTS.refreshSeconds
    ? value
    : null;
}

/** The query is the one text where "" means something (every issue): only the default is unset. */
function chosenQuery(values: Values): string | null {
  const value = values["query"];
  return typeof value === "string" && value.trim() !== SETTING_DEFAULTS.query ? value.trim() : null;
}

/**
 * `config.json`'s contents with the settings laid over them, ready for
 * `parseConfig`: each setting not at its default replaces that key, and the
 * `projectFolders` pairs replace the file's folders for the same slugs.
 */
export function overlaySettings(fileRaw: unknown, values: Values): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...obj(fileRaw) };
  for (const key of TEXT_KEYS) {
    const text = chosen(values, key);
    if (text !== null) merged[key] = text;
  }
  const query = chosenQuery(values);
  if (query !== null) merged["query"] = query;
  const refresh = chosenRefresh(values);
  if (refresh !== null) merged["refreshSeconds"] = refresh;
  const pinned = parseProjectFolders(values["projectFolders"]);
  if (Object.keys(pinned).length > 0) {
    merged["projects"] = { ...obj(merged["projects"]), ...pinned };
  }
  return merged;
}

/**
 * The keys where `config.json` is what takes effect because the setting is
 * still at its default: what the reader should enter in the Extensions dialog
 * before `config.json` can be forgotten. Empty when nothing depends on the file.
 */
export function fileOnlyKeys(fileRaw: unknown, values: Values): string[] {
  const file = obj(fileRaw);
  const keys: string[] = [];
  for (const key of TEXT_KEYS) {
    const inFile = file[key];
    if (
      chosen(values, key) === null &&
      typeof inFile === "string" &&
      inFile.trim() !== "" &&
      inFile.trim() !== SETTING_DEFAULTS[key]
    ) {
      keys.push(key);
    }
  }
  const query = file["query"];
  if (
    chosenQuery(values) === null &&
    typeof query === "string" &&
    query !== SETTING_DEFAULTS.query
  ) {
    keys.push("query");
  }
  const refresh = file["refreshSeconds"];
  if (
    chosenRefresh(values) === null &&
    typeof refresh === "number" &&
    refresh !== SETTING_DEFAULTS.refreshSeconds
  ) {
    keys.push("refreshSeconds");
  }
  const pinned = parseProjectFolders(values["projectFolders"]);
  const stray = Object.keys(obj(file["projects"])).filter((slug) => !(slug in pinned));
  if (stray.length > 0) keys.push("projectFolders");
  return keys;
}
