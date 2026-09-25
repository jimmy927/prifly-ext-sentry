/**
 * One Sentry event, read into the few things a person debugging it looks at:
 * the exception chain and its frames, the breadcrumbs that led there, the
 * request, the contexts, the tags, the release and who it happened to.
 *
 * An event arrives as Sentry's `entries` — a list of typed interfaces — plus
 * top-level fields. Each reader here takes the raw event and never throws: an
 * event with no request simply has no request.
 */

import { arr, type Json, num, obj, str } from "./read";
import { releaseName, shortRelease } from "./sentry";

export type Frame = {
  filename: string;
  function: string;
  module: string;
  lineNo: number;
  colNo: number;
  inApp: boolean;
  /** The source around the line, as `[lineNo, code]` pairs. */
  context: [number, string][];
  vars: Json | null;
};

export type Exception = {
  type: string;
  value: string;
  module: string;
  mechanism: string;
  /** null when the SDK did not say. */
  handled: boolean | null;
  /** Outermost call first, as Sentry lists them: the raising frame is last. */
  frames: Frame[];
};

export type Crumb = {
  timestamp: string;
  level: string;
  category: string;
  type: string;
  message: string;
  data: Json;
};

export type Request = {
  method: string;
  url: string;
  query: [string, string][];
  headers: [string, string][];
  data: unknown;
};

function entry(event: unknown, type: string): Json | null {
  const found = arr(obj(event)["entries"])
    .map(obj)
    .find((item) => item["type"] === type);
  return found === undefined ? null : obj(found["data"]);
}

function readFrame(raw: unknown): Frame {
  const frame = obj(raw);
  const vars = frame["vars"];
  return {
    filename: str(frame["filename"]) || str(frame["absPath"]) || "?",
    function: str(frame["function"]) || str(frame["rawFunction"]),
    module: str(frame["module"]),
    lineNo: num(frame["lineNo"]),
    colNo: num(frame["colNo"]),
    inApp: frame["inApp"] === true,
    context: arr(frame["context"])
      .map(arr)
      .map((pair): [number, string] => [num(pair[0]), str(pair[1])]),
    vars: typeof vars === "object" && vars !== null && !Array.isArray(vars) ? (vars as Json) : null,
  };
}

function framesOf(stacktrace: unknown): Frame[] {
  return arr(obj(stacktrace)["frames"]).map(readFrame);
}

/**
 * The exception chain, cause first as Sentry lists it — the last one is the
 * one that was raised. An event with no exception but a crashed or current
 * thread, or a bare stack trace, gives that stack under the event's message.
 */
export function exceptions(event: unknown): Exception[] {
  const data = entry(event, "exception");
  if (data !== null) {
    return arr(data["values"]).map(obj).map(readException);
  }
  const stack = threadStack(event) ?? entry(event, "stacktrace");
  if (stack === null) return [];
  const frames = framesOf(stack);
  if (frames.length === 0) return [];
  return [
    {
      type: "Stack",
      value: message(event),
      module: "",
      mechanism: "",
      handled: null,
      frames,
    },
  ];
}

function readException(value: Json): Exception {
  const mechanism = obj(value["mechanism"]);
  const handled = mechanism["handled"];
  return {
    type: str(value["type"]) || "Error",
    value: str(value["value"]),
    module: str(value["module"]),
    mechanism: str(mechanism["type"]),
    handled: typeof handled === "boolean" ? handled : null,
    frames: framesOf(value["stacktrace"]),
  };
}

function threadStack(event: unknown): Json | null {
  const data = entry(event, "threads");
  if (data === null) return null;
  const threads = arr(data["values"]).map(obj);
  const chosen =
    threads.find((thread) => thread["crashed"] === true) ??
    threads.find((thread) => thread["current"] === true) ??
    threads.find((thread) => arr(obj(thread["stacktrace"])["frames"]).length > 0);
  return chosen === undefined ? null : obj(chosen["stacktrace"]);
}

/** The event's own message: a logged message, or the formatted log entry. */
export function message(event: unknown): string {
  const data = entry(event, "message");
  const formatted = data === null ? "" : str(data["formatted"]) || str(data["message"]);
  return formatted || str(obj(event)["message"]);
}

export function breadcrumbs(event: unknown): Crumb[] {
  const data = entry(event, "breadcrumbs");
  if (data === null) return [];
  return arr(data["values"])
    .map(obj)
    .map((crumb) => ({
      timestamp: str(crumb["timestamp"]),
      level: str(crumb["level"]),
      category: str(crumb["category"]),
      type: str(crumb["type"]),
      message: str(crumb["message"]),
      data: obj(crumb["data"]),
    }));
}

function pairs(raw: unknown): [string, string][] {
  return arr(raw)
    .map(arr)
    .map((pair): [string, string] => [str(pair[0]), str(pair[1])]);
}

export function request(event: unknown): Request | null {
  const data = entry(event, "request");
  if (data === null) return null;
  const url = str(data["url"]);
  if (url === "") return null;
  return {
    method: str(data["method"]),
    url,
    query: pairs(data["query"]),
    headers: pairs(data["headers"]),
    data: data["data"] ?? null,
  };
}

export function tags(event: unknown): [string, string][] {
  return arr(obj(event)["tags"])
    .map(obj)
    .map((tag): [string, string] => [str(tag["key"]), str(tag["value"])]);
}

/** Each context — browser, os, runtime, device… — as its name and a short summary. */
export function contexts(event: unknown): [string, string][] {
  return Object.entries(obj(obj(event)["contexts"]))
    .filter(([name]) => name !== "trace")
    .map(([name, raw]): [string, string] => [name, contextSummary(obj(raw))])
    .filter(([, summary]) => summary !== "");
}

function contextSummary(context: Json): string {
  const named = [
    str(context["name"]),
    str(context["version"]) || str(context["model"]) || str(context["family"]),
  ]
    .filter((part) => part !== "")
    .join(" ");
  if (named !== "") return named;
  return Object.entries(context)
    .filter(
      ([key, value]) => key !== "type" && (typeof value === "string" || typeof value === "number"),
    )
    .map(([key, value]) => `${key}=${str(value)}`)
    .join(", ");
}

export function release(event: unknown): string {
  const tagged = tags(event).find(([key]) => key === "release")?.[1] ?? "";
  return releaseName(obj(event)["release"]) || shortRelease(tagged);
}

/** Who it happened to, as far as the event says: id, username, email, where. */
export function user(event: unknown): string {
  const who = obj(obj(event)["user"]);
  const geo = obj(who["geo"]);
  const place = [str(geo["city"]), str(geo["country_code"])].filter((part) => part !== "");
  return [
    str(who["id"]) === "" ? "" : `id ${str(who["id"])}`,
    str(who["username"]),
    str(who["email"]),
    str(who["ip_address"]),
    place.join(", "),
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** A performance issue's evidence — the repeated query, how often — as scalar lines. */
export function evidence(event: unknown): [string, string][] {
  const occurrence = obj(obj(event)["occurrence"]);
  return Object.entries(obj(occurrence["evidenceData"]))
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]): [string, string] => [key, str(value)]);
}

export function eventId(event: unknown): string {
  const whole = obj(event);
  return str(whole["eventID"]) || str(whole["id"]);
}

export function eventDate(event: unknown): string {
  const whole = obj(event);
  return str(whole["dateCreated"]) || str(whole["dateReceived"]);
}
