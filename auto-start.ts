/**
 * Starting a session by itself for each new Sentry error nobody works on,
 * through prifly's `api.start` (`prifly-api.ts`): on each poll, the open
 * issues of the configured levels with no session yet, oldest first, a few at
 * a time and a capped number a day.
 *
 * Each issue is tried once a day whatever prifly answers: a start it refused
 * (its caps, no folder for the project) is not asked for again every poll.
 */

import type { ExtensionApi, SettingValue, StartAnswer } from "./prifly-api";
import { obj } from "./read";
import type { Issue } from "./sentry";

export type StartSessions = {
  /** Off unless the reader turns it on. */
  enabled: boolean;
  /** The issue levels that start a session: `fatal` and `error`. */
  levels: string[];
  /** The most sessions started in any 24 hours. */
  maxPerDay: number;
  /** Only issues seen within this many hours start a session; older ones are stale. */
  maxAgeHours: number;
};

/** One try at starting a session from an issue: when, and whether one started. */
export type Attempt = { at: number; started: boolean };

export const DAY_MS = 86_400_000;

/** The most started on one poll, so a burst of new errors never floods the sidebar. */
export const MAX_PER_TICK = 3;

export const DEFAULT_START_SESSIONS: StartSessions = {
  enabled: false,
  levels: ["fatal", "error"],
  maxPerDay: 10,
  maxAgeHours: 24,
};

/** The auto-start fields read tolerantly; missing or mistyped ones take their defaults. */
export function parseStartSessions(raw: unknown): StartSessions {
  const block = obj(raw);
  const levels = Array.isArray(block["levels"])
    ? block["levels"].filter((level): level is string => typeof level === "string")
    : [...DEFAULT_START_SESSIONS.levels];
  const max = block["maxPerDay"];
  const maxAge = block["maxAgeHours"];
  return {
    enabled: block["enabled"] === true,
    levels,
    maxPerDay:
      typeof max === "number" && Number.isFinite(max) && max >= 0
        ? Math.floor(max)
        : DEFAULT_START_SESSIONS.maxPerDay,
    maxAgeHours:
      typeof maxAge === "number" && Number.isFinite(maxAge) && maxAge > 0
        ? maxAge
        : DEFAULT_START_SESSIONS.maxAgeHours,
  };
}

/**
 * The same, from the settings the Extensions page keeps (`prifly-extension.json`
 * declares them): `startSessions`, `startLevels`, `startMaxPerDay`, `startMaxAgeHours`.
 */
export function startSessionsFrom(values: Readonly<Record<string, SettingValue>>): StartSessions {
  return parseStartSessions({
    enabled: values["startSessions"],
    levels: values["startLevels"],
    maxPerDay: values["startMaxPerDay"],
    maxAgeHours: values["startMaxAgeHours"],
  });
}

/** Whether this prifly keeps the settings (`api.settings`); without it the defaults apply. */
export function hasSettings(api: ExtensionApi): boolean {
  return (api.features ?? []).includes("settings") && api.settings !== undefined;
}

/** The attempts of the last day; older ones are forgotten. */
export function recentAttempts(
  attempted: Record<string, Attempt>,
  now: number,
): Record<string, Attempt> {
  return Object.fromEntries(
    Object.entries(attempted).filter(([, attempt]) => now - attempt.at < DAY_MS),
  );
}

/**
 * The issues to start a session from now, in order: open, of a configured
 * level, last seen within `maxAgeHours` (an unreadable `lastSeen` is stale),
 * on no session, not tried in the last day — oldest first seen first,
 * at most `MAX_PER_TICK`, and no more than the day's starts leave room for.
 */
export function issuesToStart(
  issues: readonly Issue[],
  worked: ReadonlySet<string>,
  attempted: Record<string, Attempt>,
  config: StartSessions,
  now: number,
): Issue[] {
  if (!config.enabled) return [];
  const recent = recentAttempts(attempted, now);
  const startedToday = Object.values(recent).filter((attempt) => attempt.started).length;
  const room = Math.min(MAX_PER_TICK, config.maxPerDay - startedToday);
  if (room <= 0) return [];
  const levels = new Set(config.levels);
  const oldest = now - config.maxAgeHours * 3_600_000;
  return issues
    .filter(
      (issue) =>
        issue.status !== "resolved" &&
        issue.status !== "ignored" &&
        levels.has(issue.level) &&
        lastSeen(issue) >= oldest &&
        !worked.has(issue.id) &&
        recent[issue.id] === undefined,
    )
    .sort((a, b) => firstSeen(a) - firstSeen(b))
    .slice(0, room);
}

/** When the issue was last seen; NaN when unreadable, which no cut-off admits. */
function lastSeen(issue: Issue): number {
  return Date.parse(issue.lastSeen);
}

function firstSeen(issue: Issue): number {
  return Date.parse(issue.firstSeen) || 0;
}

/** `api.start`, where this prifly has it; undefined on one that predates it. */
export function starter(
  api: ExtensionApi,
): ((launchId: string, key: string) => Promise<StartAnswer>) | undefined {
  if (!(api.features ?? []).includes("start-session")) return undefined;
  return typeof api.start === "function" ? api.start.bind(api) : undefined;
}
