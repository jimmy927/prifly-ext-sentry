/**
 * An issue as it looks in prifly: a card in the chooser, the issue read whole
 * over the board, and the chip on the banner of the session started from it.
 *
 * The chooser's columns are Sentry's own triage states for an unresolved
 * issue — new, escalating, regressed, ongoing — so the board reads the way
 * Sentry's issue stream does; what the reader's code is doing wrong right
 * now sits on the left.
 */

import { issueMarkdown } from "./issue-prompt";
import type {
  Decoration,
  DecorationAction,
  DecorationTone,
  LabelColour,
  LaunchChoice,
  LaunchColumn,
  LauncherFlag,
  LaunchItem,
  LaunchItemNote,
  LaunchSpark,
} from "./prifly-api";
import { clip } from "./read";
import type { Issue } from "./sentry";
import { ago } from "./time";

export const COLUMNS: LaunchColumn[] = [
  { id: "new", name: "New" },
  { id: "escalating", name: "Escalating" },
  { id: "regressed", name: "Regressed" },
  { id: "ongoing", name: "Ongoing" },
];

/** The column an issue sits in; anything Sentry adds later lands in Ongoing. */
export function columnOf(issue: Issue): string {
  return COLUMNS.find((column) => column.id === issue.substatus)?.id ?? "ongoing";
}

const LEVEL_COLOURS: Record<string, LabelColour> = {
  fatal: "red",
  error: "orange",
  warning: "yellow",
  info: "blue",
  debug: "grey",
};

export function levelColour(level: string): LabelColour {
  return LEVEL_COLOURS[level] ?? "grey";
}

/** Loud only for what is loud in Sentry: a fatal, or one that is getting worse. */
export function issueTone(issue: Issue): DecorationTone {
  if (issue.status === "resolved") return "good";
  if (issue.status === "ignored") return "muted";
  if (issue.level === "fatal") return "critical";
  if (issue.substatus === "escalating" || issue.substatus === "regressed") return "warning";
  return "info";
}

/**
 * The launcher button's glow: red while any open issue is a fatal or an
 * error, orange while the open ones are only warnings or info, out when
 * nothing is open. Debug never lights it.
 */
export function launcherFlag(issues: readonly Issue[]): LauncherFlag | null {
  const open = issues.filter((issue) => issue.status !== "resolved" && issue.status !== "ignored");
  const errors = open.filter((issue) => issue.level === "fatal" || issue.level === "error");
  if (errors.length > 0) return { tone: "critical", hint: plural(errors.length, "open error") };
  const warnings = open.filter((issue) => issue.level === "warning" || issue.level === "info");
  if (warnings.length > 0)
    return { tone: "warning", hint: plural(warnings.length, "open warning") };
  return null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What the issue's menu offers for the status it has now. */
export function statusActions(issue: Issue): DecorationAction[] {
  const name = clip(issue.title, 60);
  if (issue.status !== "unresolved") {
    return [{ id: "unresolve", label: "Unresolve" }];
  }
  return [
    {
      id: "resolve",
      label: "Resolve",
      confirm: `${issue.shortId} “${name}” is marked resolved in Sentry. It comes back as a regression if it happens again.`,
    },
    {
      id: "ignore",
      label: "Archive until it escalates",
      confirm: `${issue.shortId} “${name}” leaves the unresolved list until it happens much more often, and your bookmarks for good.`,
      destructive: true,
    },
  ];
}

/**
 * The line at the foot of the card: `ODI-GC6 · 3 users · 3d ago`. The culprit
 * has its own line and the bars say how many events; without bars, the
 * events and the culprit are said here instead.
 */
function detail(
  issue: Issue,
  withProject: boolean,
  now: number,
  barred: boolean,
  folderNote: string,
): string {
  const seen = ago(issue.lastSeen, now);
  return [
    withProject ? `${issue.project} ${issue.shortId}` : issue.shortId,
    barred ? "" : clip(issue.culprit, 60),
    barred ? `${issue.userCount} users` : `${issue.count} events · ${issue.userCount} users`,
    seen === "" ? "" : `${seen} ago`,
    folderNote,
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/**
 * An issue as a card. `folderNote` says why a session from it will ask for
 * its folder — "no code mapping for odi" — and is "" when the folder is known.
 */
export function issueFace(
  issue: Issue,
  withProject: boolean,
  now: number,
  sparks: LaunchSpark[] = [],
  folderNote = "",
): LaunchChoice {
  return {
    key: issue.id,
    title: issue.title,
    group: columnOf(issue),
    detail: detail(issue, withProject, now, sparks.length > 0, folderNote),
    sub: sparks.length > 0 ? issue.culprit : "",
    sparks,
    tone: issueTone(issue),
    url: issue.permalink,
    stripes: [levelColour(issue.level)],
    actions: statusActions(issue),
    people: issue.assignee === "" ? [] : [issue.assignee],
    badges: { comments: issue.numComments },
  };
}

/** The issue read whole, over the board: facts, trace, breadcrumbs, and the notes left on it. */
export function issueItem(
  issue: Issue,
  event: unknown,
  notes: LaunchItemNote[],
  now: number,
): LaunchItem {
  const column = columnOf(issue);
  return {
    title: issue.title,
    url: issue.permalink,
    column,
    columnName: COLUMNS.find((entry) => entry.id === column)?.name ?? "",
    labels: [
      { colour: levelColour(issue.level), name: issue.level },
      { colour: "grey", name: issue.project },
      { colour: "grey", name: issue.shortId },
    ],
    people: issue.assignee === "" ? [] : [issue.assignee],
    markdown: issueMarkdown(issue, event, now),
    notes,
  };
}

/** The chip on the banner: the short id, its title, and whether it is still open. */
export function issueChip(issue: Issue, now: number): Decoration {
  const status = issue.substatus === "" ? issue.status : `${issue.status} (${issue.substatus})`;
  const seen = ago(issue.lastSeen, now);
  return {
    key: issue.id,
    icon: "sentry",
    label: `${issue.shortId}${issue.status === "unresolved" ? "" : ` ${issue.status}`}: ${clip(issue.title, 40)}`,
    tone: issueTone(issue),
    details: [
      issue.title,
      `${issue.project} › ${issue.shortId} · ${issue.level} · ${status}`,
      issue.culprit,
      `${issue.count} events · ${issue.userCount} users${seen === "" ? "" : ` · last seen ${seen} ago`}`,
      issue.permalink,
    ].filter((line) => line !== ""),
    url: issue.permalink,
    actions: statusActions(issue),
  };
}
