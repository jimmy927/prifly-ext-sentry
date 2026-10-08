import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Attempt,
  DAY_MS,
  DEFAULT_START_SESSIONS,
  hasSettings,
  issuesToStart,
  parseStartSessions,
  type StartSessions,
  startSessionsFrom,
} from "../auto-start";
import { startNew } from "../index";
import type { ExtensionApi, StartAnswer } from "../prifly-api";
import { type Issue, readIssue } from "../sentry";
import { linkIssue, parseConfig, parseState, unlinkIssue, type World } from "../world";
import { NOW, rawIssue } from "./fixtures";

const base = readIssue(rawIssue);

function issue(
  id: string,
  level = "error",
  firstSeen = "2026-09-20T08:00:00Z",
  status = "unresolved",
): Issue {
  return { ...base, id, shortId: `SHOP-${id}`, level, status, firstSeen };
}

const on: StartSessions = { ...DEFAULT_START_SESSIONS, enabled: true };
const none = new Set<string>();

const ids = (issues: Issue[]) => issues.map((entry) => entry.id);

describe("parseStartSessions", () => {
  test("missing or malformed reads as the default, which is off", () => {
    expect(parseStartSessions(undefined)).toEqual(DEFAULT_START_SESSIONS);
    expect(parseStartSessions("yes")).toEqual(DEFAULT_START_SESSIONS);
    expect(parseStartSessions({ enabled: "true", levels: 3, maxPerDay: -1 })).toEqual(
      DEFAULT_START_SESSIONS,
    );
  });

  test("reads what is given", () => {
    expect(parseStartSessions({ enabled: true, levels: ["fatal", 7], maxPerDay: 2 })).toEqual({
      enabled: true,
      levels: ["fatal"],
      maxPerDay: 2,
    });
  });

  test("is part of the config", () => {
    const clirc = { token: "", org: "", url: "" };
    expect(parseConfig({}, {}, clirc, "/h").startSessions).toEqual(DEFAULT_START_SESSIONS);
  });
});

describe("startSessionsFrom", () => {
  test("reads the Extensions page's settings", () => {
    expect(
      startSessionsFrom({ startSessions: true, startLevels: ["fatal"], startMaxPerDay: 3 }),
    ).toEqual({ enabled: true, levels: ["fatal"], maxPerDay: 3 });
    expect(startSessionsFrom({})).toEqual(DEFAULT_START_SESSIONS);
  });

  test("they count only where prifly says it keeps settings", () => {
    const api = (over: object) => ({ ...over }) as unknown as ExtensionApi;
    expect(hasSettings(api({ features: ["settings"], settings: {} }))).toBe(true);
    expect(hasSettings(api({ features: [], settings: {} }))).toBe(false);
    expect(hasSettings(api({ features: ["settings"] }))).toBe(false);
  });
});

describe("issuesToStart", () => {
  test("nothing while it is off", () => {
    expect(issuesToStart([issue("a")], none, {}, DEFAULT_START_SESSIONS, NOW)).toEqual([]);
  });

  test("only open issues of the configured levels", () => {
    const issues = [
      issue("err"),
      issue("fat", "fatal"),
      issue("warn", "warning"),
      issue("res", "error", undefined, "resolved"),
      issue("ign", "error", undefined, "ignored"),
    ];
    expect(ids(issuesToStart(issues, none, {}, on, NOW))).toEqual(["err", "fat"]);
    expect(ids(issuesToStart(issues, none, {}, { ...on, levels: ["warning"] }, NOW))).toEqual([
      "warn",
    ]);
  });

  test("not one a session already works on", () => {
    expect(ids(issuesToStart([issue("a"), issue("b")], new Set(["a"]), {}, on, NOW))).toEqual([
      "b",
    ]);
  });

  test("not one tried in the last day, started or not; an older try is forgotten", () => {
    const attempted: Record<string, Attempt> = {
      a: { at: NOW - 60_000, started: false },
      b: { at: NOW - DAY_MS - 1, started: false },
    };
    expect(ids(issuesToStart([issue("a"), issue("b")], none, attempted, on, NOW))).toEqual(["b"]);
  });

  test("oldest first seen first, and at most three a poll", () => {
    const issues = [
      issue("d", "error", "2026-09-24T00:00:00Z"),
      issue("a", "error", "2026-09-21T00:00:00Z"),
      issue("c", "error", "2026-09-23T00:00:00Z"),
      issue("b", "error", "2026-09-22T00:00:00Z"),
    ];
    expect(ids(issuesToStart(issues, none, {}, on, NOW))).toEqual(["a", "b", "c"]);
  });

  test("no more than the day's cap, counting only starts that happened", () => {
    const attempted: Record<string, Attempt> = {
      x: { at: NOW - 1000, started: true },
      y: { at: NOW - 2000, started: false },
      z: { at: NOW - DAY_MS - 1, started: true },
    };
    const issues = [issue("a"), issue("b"), issue("c")];
    expect(ids(issuesToStart(issues, none, attempted, { ...on, maxPerDay: 2 }, NOW))).toEqual([
      "a",
    ]);
    expect(issuesToStart(issues, none, attempted, { ...on, maxPerDay: 1 }, NOW)).toEqual([]);
  });
});

/** A world with a fake prifly that records each `start`, answering with `answer`. */
function fakeWorld(features: string[] | undefined, withStart = true) {
  const calls: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const api = {
    folder: mkdtempSync(join(tmpdir(), "sentry-auto-start-")),
    features,
    sessions: () => [],
    log: (event: string, fields?: Record<string, unknown>) => {
      if (event === "auto_start") logged.push(fields ?? {});
    },
    ...(withStart
      ? {
          start: async (launchId: string, key: string): Promise<StartAnswer> => {
            calls.push(`${launchId}:${key}`);
            return { started: true, sessionId: `session-${key}-0000` };
          },
        }
      : {}),
  } as unknown as ExtensionApi;
  const clirc = { token: "", org: "", url: "" };
  const world: World = {
    api,
    config: { ...parseConfig({}, {}, clirc, "/h"), startSessions: on },
    login: null,
    state: parseState({}),
    issues: [issue("a")],
    mappings: [],
    loadedAt: NOW,
    linked: new Map(),
    sparks: new Map(),
  };
  return { world, calls, logged };
}

describe("startNew", () => {
  test("starts a new error once, logs it, and never asks for it again", async () => {
    const { world, calls, logged } = fakeWorld(["start-session"]);
    await startNew(world, NOW);
    await startNew(world, NOW + 120_000);
    expect(calls).toEqual(["issue:a"]);
    expect(logged).toEqual([{ issue: "SHOP-a", started: true, session: "session-", reason: null }]);
    expect(world.state.attempted["a"]).toEqual({ at: NOW, started: true });
  });

  test("makes no call where prifly lacks the feature or the method", async () => {
    for (const { world, calls } of [
      fakeWorld(undefined),
      fakeWorld(["pick-links"]),
      fakeWorld(["start-session"], false),
    ]) {
      await startNew(world, NOW);
      expect(calls).toEqual([]);
      expect(world.state.attempted).toEqual({});
    }
  });

  test("makes no call while it is off", async () => {
    const { world, calls } = fakeWorld(["start-session"]);
    world.config.startSessions = DEFAULT_START_SESSIONS;
    await startNew(world, NOW);
    expect(calls).toEqual([]);
  });

  describe("an issue whose session is gone from prifly", () => {
    const seenAt = (ms: number) => ({ ...issue("a"), lastSeen: new Date(ms).toISOString() });

    test("(a) stays unstarted while its link says a session worked it", async () => {
      const { world, calls } = fakeWorld(["start-session"]);
      world.issues = [seenAt(NOW - 16 * 3_600_000)];
      linkIssue(world.state, "gone-session", "a", NOW - 15 * 3_600_000);
      await startNew(world, NOW);
      expect(calls).toEqual([]);
    });

    test("(b) starts again when it was seen after the link", async () => {
      const { world, calls } = fakeWorld(["start-session"]);
      world.issues = [seenAt(NOW - 60_000)];
      linkIssue(world.state, "gone-session", "a", NOW - 3_600_000);
      await startNew(world, NOW);
      expect(calls).toEqual(["issue:a"]);
    });

    test("a newer event does not start a second session while the first is listed", async () => {
      const { world, calls } = fakeWorld(["start-session"]);
      (world.api as { sessions: () => unknown }).sessions = () => [{ id: "live-session" }];
      world.issues = [seenAt(NOW - 60_000)];
      linkIssue(world.state, "live-session", "a", NOW - 3_600_000);
      await startNew(world, NOW);
      expect(calls).toEqual([]);
    });

    test("(c) a legacy link with no time never reopens it", async () => {
      const { world, calls } = fakeWorld(["start-session"]);
      world.state = parseState({ links: { "gone-session": ["a"] } });
      expect(world.state.linkedAt).toEqual({});
      world.issues = [seenAt(NOW - 60_000)];
      await startNew(world, NOW);
      expect(calls).toEqual([]);
    });

    test("(d) unlinking forgets the link and its time", async () => {
      const { world, calls } = fakeWorld(["start-session"]);
      world.issues = [seenAt(NOW - 16 * 3_600_000)];
      linkIssue(world.state, "gone-session", "a", NOW - 15 * 3_600_000);
      unlinkIssue(world.state, "gone-session", "a");
      expect(world.state.linkedAt).toEqual({});
      await startNew(world, NOW);
      expect(calls).toEqual(["issue:a"]);
    });

    test("unlinking keeps the time while another session still carries the issue", () => {
      const state = parseState({});
      linkIssue(state, "s1", "a", 5);
      linkIssue(state, "s2", "a", 6);
      unlinkIssue(state, "s1", "a");
      expect(state.linkedAt).toEqual({ a: 6 });
      expect(parseState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    });
  });
});
