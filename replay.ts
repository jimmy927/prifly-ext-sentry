/**
 * A Sentry session replay, told as a timeline a person (or a model) can read.
 *
 * Sentry stores a replay as rrweb recording segments: lists of events, each
 * with a millisecond timestamp. Sentry's SDK adds its own `custom` events —
 * breadcrumbs (clicks, inputs, navigations, console lines) and performance
 * spans (page loads, fetch and XHR calls). The rest is rrweb's: full
 * snapshots of the DOM, then incremental mutations, mouse moves, scrolls.
 *
 * The timeline keeps what explains a moment: where the user was, what they
 * clicked and typed into, which calls went out and how they answered, what
 * the console said, and what the DOM did — mutations grouped per second,
 * with any trace an extension or a translator left (`dom.ts`). Mouse moves
 * and scrolls are left out.
 */

import { type Change, Dom, emptyChange } from "./dom";
import { arr, clip, type Json, num, obj, str } from "./read";

/** A replay's facts, from `GET /organizations/{org}/replays/{id}/`'s `data`. */
export type ReplayFacts = {
  id: string;
  projectId: string;
  startedAt: string;
  finishedAt: string;
  duration: number;
  urls: string[];
  user: string;
  browser: string;
  os: string;
  device: string;
  environment: string;
  releases: string[];
  countErrors: number;
  errorIds: string[];
  countSegments: number;
};

function named(raw: unknown): string {
  const thing = obj(raw);
  return [str(thing["name"]), str(thing["version"])].filter(Boolean).join(" ");
}

export function readReplay(raw: unknown): ReplayFacts {
  const replay = obj(raw);
  const user = obj(replay["user"]);
  return {
    id: str(replay["id"]),
    projectId: str(replay["project_id"]),
    startedAt: str(replay["started_at"]),
    finishedAt: str(replay["finished_at"]),
    duration: num(replay["duration"]),
    urls: arr(replay["urls"]).map(str),
    user: [
      str(user["display_name"]),
      str(user["id"]) && `id ${str(user["id"])}`,
      str(user["email"]),
    ]
      .filter(Boolean)
      .filter((part, i, all) => all.indexOf(part) === i)
      .join(" · "),
    browser: named(replay["browser"]),
    os: named(replay["os"]),
    device: [str(obj(replay["device"])["brand"]), str(obj(replay["device"])["model"])]
      .filter(Boolean)
      .join(" "),
    environment: str(replay["environment"]),
    releases: arr(replay["releases"]).map(str),
    countErrors: num(replay["count_errors"]),
    errorIds: arr(replay["error_ids"]).map(str),
    countSegments: num(replay["count_segments"]),
  };
}

/** A replay id from an id or a Sentry replay URL; "" when there is none. */
export function replayIdOf(ref: string): string {
  const hit = /(?:^|\/replays\/)([0-9a-f]{32})(?:[/?#]|$)/i.exec(ref.trim().replace(/-/g, ""));
  return hit?.[1]?.toLowerCase() ?? "";
}

type Line = { at: number; text: string };

/** rrweb's event types and incremental sources that the timeline reads. */
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const CUSTOM = 5;
const MUTATION = 0;
const VIEWPORT = 4;

/** rrweb stamps milliseconds; some of Sentry's own payloads stamp seconds. */
function millis(value: unknown): number {
  const at = num(value);
  return at > 0 && at < 1e11 ? at * 1000 : at;
}

/** Every event of every segment, oldest first. */
export function eventsOf(segments: unknown[]): Json[] {
  return segments
    .flatMap((segment) => arr(segment))
    .map(obj)
    .sort((a, b) => millis(a["timestamp"]) - millis(b["timestamp"]));
}

function breadcrumbLine(payload: Json, at: number): Line | null {
  const category = str(payload["category"]);
  const data = obj(payload["data"]);
  const message = clip(str(payload["message"]), 300);
  switch (category) {
    case "console":
      return { at, text: `console.${str(payload["level"]) || "log"}  ${message}` };
    case "ui.click":
    case "ui.tap":
      return { at, text: `click  ${message}` };
    case "ui.input":
      return { at, text: `input  ${message}` };
    case "ui.slowClickDetected":
      return { at, text: `dead click  ${message}` };
    case "ui.multiClick":
      return { at, text: `rage click  ${message} (${num(data["clickCount"])}×)` };
    case "navigation":
      return { at, text: `navigate  ${str(data["from"])} → ${str(data["to"])}` };
    case "ui.focus":
      return { at, text: "tab focused" };
    case "ui.blur":
      return { at, text: "tab left (blur)" };
    case "replay.mutations":
      return { at, text: `large DOM mutation  ${num(data["count"])} nodes` };
    default:
      return { at, text: `${category || "breadcrumb"}  ${message}`.trim() };
  }
}

function spanLine(payload: Json): Line | null {
  const op = str(payload["op"]);
  const at = millis(payload["startTimestamp"]);
  const took = Math.round(millis(payload["endTimestamp"]) - at);
  const data = obj(payload["data"]);
  const url = clip(str(payload["description"]), 200);
  if (op === "resource.fetch" || op === "resource.xhr") {
    const status = str(data["statusCode"]) || "?";
    return {
      at,
      text: `${op.slice(9)}  ${str(data["method"]) || "GET"} ${url} → ${status} (${took} ms)`,
    };
  }
  if (op.startsWith("navigation.")) return { at, text: `page ${op.slice(11)}  ${url}` };
  return null;
}

function customLine(event: Json): Line | null {
  const data = obj(event["data"]);
  const payload = obj(data["payload"]);
  const tag = str(data["tag"]);
  if (tag === "breadcrumb") return breadcrumbLine(payload, millis(event["timestamp"]));
  if (tag === "performanceSpan") return spanLine(payload);
  if (tag === "options" && payload["maskAllText"] === true) {
    return {
      at: millis(event["timestamp"]),
      text: "recording options  all text masked (shown as *)",
    };
  }
  return null;
}

function markerText(markers: Map<string, number>): string {
  return [...markers].map(([who, count]) => `${who} ×${count}`).join("; ");
}

function changeLine(at: number, change: Change): Line {
  const counts = [
    change.added && `+${change.added} nodes`,
    change.removed && `−${change.removed} nodes`,
    change.texts && `${change.texts} text`,
    change.attributes && `${change.attributes} attribute`,
  ].filter(Boolean);
  const parts = [`DOM  ${counts.join(", ")}`];
  if (change.markers.size > 0) parts.push(`  ⚑ ${markerText(change.markers)}`);
  for (const sample of change.samples) parts.push(`\n      ${sample}`);
  return { at, text: parts.join("") };
}

function snapshotLine(at: number, dom: Dom, change: Change): Line {
  const html = Object.entries(dom.htmlAttributes())
    .map(([name, value]) => `${name}="${clip(value, 60)}"`)
    .join(" ");
  const markers = dom.markers();
  const flagged = markers.size === 0 ? "" : `  ⚑ ${markerText(markers)}`;
  const samples = change.samples.map((sample) => `\n      ${sample}`).join("");
  return { at, text: `DOM snapshot  <html ${html}>${flagged}${samples}` };
}

/** One event that is not a mutation, as a line; null for what the timeline leaves out. */
function eventLine(event: Json, dom: Dom): Line | null {
  const at = millis(event["timestamp"]);
  const type = num(event["type"]);
  const data = obj(event["data"]);
  const size = `${num(data["width"])}×${num(data["height"])}`;
  if (type === FULL_SNAPSHOT) return snapshotLine(at, dom, dom.snapshot(data["node"]));
  if (type === META) return { at, text: `page  ${str(data["href"])}  (${size})` };
  if (type === INCREMENTAL && num(data["source"]) === VIEWPORT) {
    return { at, text: `viewport  ${size}` };
  }
  if (type === CUSTOM) return customLine(event);
  return null;
}

/** The whole recording as timeline lines: mutations grouped per second. */
export function timeline(events: Json[]): Line[] {
  const dom = new Dom();
  const lines: Line[] = [];
  let pending: { at: number; change: Change } | null = null;
  const flush = () => {
    if (pending !== null) lines.push(changeLine(pending.at, pending.change));
    pending = null;
  };
  for (const event of events) {
    const at = millis(event["timestamp"]);
    const data = obj(event["data"]);
    if (num(event["type"]) === INCREMENTAL && num(data["source"]) === MUTATION) {
      if (pending !== null && at - pending.at >= 1000) flush();
      pending ??= { at, change: emptyChange() };
      dom.mutate(data, pending.change);
      continue;
    }
    // A snapshot replaces the page: the mutations before it are told on the old one.
    if (num(event["type"]) === FULL_SNAPSHOT) flush();
    const line = eventLine(event, dom);
    if (line !== null) lines.push(line);
  }
  flush();
  return lines.sort((a, b) => a.at - b.at);
}

/** "+1:02.345" from the replay's start. */
function offset(at: number, start: number): string {
  const ms = Math.max(0, at - start);
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(3).padStart(6, "0");
  return `+${minutes}:${seconds}`;
}

export type Focus = { around: number | null; window: number; limit: number };

/** The replay's facts, then its timeline — all of it, or the seconds around `around`. */
export function replayText(facts: ReplayFacts, events: Json[], focus: Focus): string {
  const all = timeline(events);
  const start = Date.parse(facts.startedAt) || all[0]?.at || 0;
  let shown = all;
  let scope = "whole replay";
  if (focus.around !== null) {
    const from = focus.around - focus.window * 1000;
    const to = focus.around + focus.window * 1000;
    shown = all.filter((line) => line.at >= from && line.at <= to);
    scope = `${focus.window} s either side of ${new Date(focus.around).toISOString()}`;
  }
  const cut = shown.length > focus.limit;
  if (cut) shown = shown.slice(0, focus.limit);
  const body = shown.map(
    (line) =>
      `${offset(line.at, start)}  ${new Date(line.at).toISOString().slice(11, 23)}  ${line.text}`,
  );
  const header = [
    `# Replay ${facts.id}`,
    `${facts.startedAt} → ${facts.finishedAt} (${facts.duration} s) · ${facts.countSegments} segments · ${facts.countErrors} errors`,
    `user: ${facts.user || "?"} · ${[facts.browser, facts.os, facts.device].filter(Boolean).join(" · ")}`,
    `environment: ${facts.environment || "?"} · release: ${facts.releases.join(", ") || "?"}`,
    `errors: ${facts.errorIds.join(", ") || "none"}`,
    `urls: ${facts.urls.join("  ") || "none"}`,
    "",
    `## Timeline (${scope}; times UTC; ⚑ marks a trace of an extension or translator)`,
    "",
  ];
  const tail = cut
    ? [
        `… ${all.length} lines in all; cut at ${focus.limit}. Pass \`around\` and \`window\` to see a moment.`,
      ]
    : [];
  if (body.length === 0) body.push("(nothing recorded in this span)");
  return [...header, ...body, ...tail].join("\n");
}
