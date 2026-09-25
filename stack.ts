/**
 * A stack trace, cut to what a person reads first.
 *
 * Sentry keeps every frame — Django's middleware, the event loop, the
 * framework's own twenty calls between a request and your view. The frames
 * that are the reader's own code (`inApp`) are the story; the rest are folded
 * into a count, except the frame that actually raised, which is kept wherever
 * it is because that is where the error came from. The innermost in-app frame
 * gets its surrounding source and its local variables: that is the line the
 * fix usually goes near.
 *
 * The whole trace is on disk in the saved event for when this is not enough.
 */

import type { Exception, Frame } from "./event";
import { brief, clip } from "./read";

export type Kept = { frame: Frame; index: number } | { folded: number };

/** Frames kept when a trace has no in-app frame at all: the innermost few. */
const NO_APP_TAIL = 8;

/**
 * Which frames to show, outermost first: in-app frames and the raising one,
 * with each run of other frames folded into a count, and at most `max` frames
 * — the innermost ones, since that is where it broke.
 */
export function trimFrames(frames: readonly Frame[], max = 25): Kept[] {
  const last = frames.length - 1;
  const anyApp = frames.some((frame) => frame.inApp);
  const wanted = frames.map(
    (frame, index) => index === last || (anyApp ? frame.inApp : index >= last - NO_APP_TAIL + 1),
  );
  const keptIndexes = wanted.flatMap((keep, index) => (keep ? [index] : []));
  const allowed = new Set(keptIndexes.slice(-max));
  const out: Kept[] = [];
  let folded = 0;
  for (const [index, frame] of frames.entries()) {
    if (allowed.has(index)) {
      if (folded > 0) out.push({ folded });
      folded = 0;
      out.push({ frame, index });
    } else folded += 1;
  }
  if (folded > 0) out.push({ folded });
  return out;
}

/** Where a frame is, in one line: `core/views.py:21 in get`. */
export function frameLine(frame: Frame): string {
  // A sourcemapped browser frame is named relative to the bundle: `../../../../frontend/x.ts`.
  const file = frame.filename.replace(/^(\.\.\/)+/, "");
  const where = frame.lineNo > 0 ? `${file}:${frame.lineNo}` : file;
  const column = frame.colNo > 0 ? `:${frame.colNo}` : "";
  const name = frame.function === "" ? "" : ` in ${frame.function}`;
  return `${where}${column}${name}${frame.inApp ? "" : "  [library]"}`;
}

/** The source line the frame stopped on, or "" when Sentry has no source. */
function sourceLine(frame: Frame): string {
  return frame.context.find(([line]) => line === frame.lineNo)?.[1].trim() ?? "";
}

/** The source around the line, the line itself marked. */
function sourceBlock(frame: Frame): string[] {
  return frame.context.map(
    ([line, code]) =>
      `    ${line === frame.lineNo ? ">" : " "} ${String(line).padStart(5)} | ${clip(code, 160)}`,
  );
}

const MOST_VARS = 20;

function varsBlock(frame: Frame): string[] {
  if (frame.vars === null) return [];
  const entries = Object.entries(frame.vars);
  if (entries.length === 0) return [];
  const lines = entries
    .slice(0, MOST_VARS)
    .map(([name, value]) => `      ${name} = ${brief(value, 200)}`);
  const more = entries.length > MOST_VARS ? [`      … ${entries.length - MOST_VARS} more`] : [];
  return ["    locals:", ...lines, ...more];
}

/** The index of the frame that gets its source and locals: the innermost in-app one. */
function focusIndex(frames: readonly Frame[]): number {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (frames[index]?.inApp === true) return index;
  }
  return frames.length - 1;
}

/** One trimmed trace as plain text, most recent call last. */
export function renderFrames(frames: readonly Frame[], max = 25): string {
  const focus = focusIndex(frames);
  const lines: string[] = [];
  for (const kept of trimFrames(frames, max)) {
    if ("folded" in kept) {
      lines.push(`  … ${kept.folded} library frame${kept.folded === 1 ? "" : "s"} …`);
      continue;
    }
    lines.push(`  ${frameLine(kept.frame)}`);
    if (kept.index === focus && kept.frame.context.length > 0) {
      lines.push(...sourceBlock(kept.frame), ...varsBlock(kept.frame));
    } else {
      const source = sourceLine(kept.frame);
      if (source !== "") lines.push(`      ${clip(source, 160)}`);
    }
  }
  return lines.join("\n");
}

/** An exception's heading line: `AssertionError: No ref for EmailReport request`. */
export function exceptionTitle(exception: Exception): string {
  const value = clip(exception.value.trim(), 1000);
  return value === "" ? exception.type : `${exception.type}: ${value}`;
}

/**
 * The exception chain as Markdown, the raised exception first and each cause
 * after it — the reverse of Sentry's list, because the raised one is what the
 * issue is about.
 */
export function renderChain(chain: readonly Exception[], max = 25): string {
  return [...chain]
    .reverse()
    .map((exception, at) => {
      const how = [
        exception.mechanism === "" ? "" : `mechanism ${exception.mechanism}`,
        exception.handled === null ? "" : exception.handled ? "handled" : "unhandled",
      ].filter((part) => part !== "");
      const heading = `### ${at === 0 ? "" : "Caused by "}${exceptionTitle(exception)}`;
      const note = how.length === 0 ? "" : `\n${how.join(", ")}`;
      const trace =
        exception.frames.length === 0
          ? "\n\n(no stack trace)"
          : `\n\n\`\`\`text\n${renderFrames(exception.frames, max)}\n\`\`\``;
      return `${heading}${note}${trace}`;
    })
    .join("\n\n");
}
