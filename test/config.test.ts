import { describe, expect, test } from "bun:test";
import { looksLikeToken, parseClirc } from "../auth";
import { alreadyStarted, matches } from "../index";
import { columnOf, issueChip, issueFace, statusActions } from "../issue-face";
import { readIssue, readNotes, shortRelease } from "../sentry";
import { ago, when } from "../time";
import {
  expandHome,
  linkIssue,
  parseConfig,
  parseState,
  type State,
  sortIssues,
  unlinkIssue,
} from "../world";
import { NOW, rawIssue } from "./fixtures";

const noClirc = { token: "", org: "", url: "" };

describe("parseConfig", () => {
  test("an empty file gives the defaults", () => {
    expect(parseConfig({}, {}, noClirc, "/home/me")).toEqual({
      org: "",
      baseUrl: "https://sentry.io",
      projects: {},
      query: "is:unresolved",
      period: "14d",
      sort: "date",
      refreshSeconds: 120,
      startSessions: { enabled: false, levels: ["fatal", "error"], maxPerDay: 10 },
    });
  });

  test("maps projects to folders, expanding ~ and dropping what is not a folder", () => {
    const config = parseConfig(
      { org: "acme", projects: { odi: "~/odi", web: "/srv/web", bad: 3, empty: " " } },
      {},
      noClirc,
      "/home/me",
    );
    expect(config.org).toBe("acme");
    expect(config.projects).toEqual({ odi: "/home/me/odi", web: "/srv/web" });
  });

  test("the organization and server fall back to the environment, then ~/.sentryclirc", () => {
    const clirc = { token: "t", org: "from-rc", url: "https://sentry.example.com/" };
    expect(parseConfig({}, {}, clirc, "/h").org).toBe("from-rc");
    expect(parseConfig({}, {}, clirc, "/h").baseUrl).toBe("https://sentry.example.com");
    expect(parseConfig({}, { SENTRY_ORG: "from-env" }, clirc, "/h").org).toBe("from-env");
  });

  test("an unknown sort is the default, and refreshing is never faster than 30s", () => {
    const config = parseConfig({ sort: "random", refreshSeconds: 1 }, {}, noClirc, "/h");
    expect(config.sort).toBe("date");
    expect(config.refreshSeconds).toBe(30);
    expect(parseConfig({ sort: "freq" }, {}, noClirc, "/h").sort).toBe("freq");
  });

  test("expandHome leaves absolute and relative paths alone", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("/abs", "/h")).toBe("/abs");
    expect(expandHome("rel/x", "/h")).toBe("rel/x");
  });
});

describe("parseState", () => {
  test("keeps only string links and folders", () => {
    expect(
      parseState({
        links: { s1: ["5001", 7, "5002", "5001"], s2: 7, s3: [] },
        folders: { odi: "/home/me/src/odi", web: "", bad: 3 },
        addingProject: true,
      }),
    ).toEqual({
      links: { s1: ["5001", "5002"] },
      folders: { odi: "/home/me/src/odi" },
      attempted: {},
    });
    expect(parseState(null)).toEqual({ links: {}, folders: {}, attempted: {} });
  });

  test("keeps only timed tries at starting a session", () => {
    expect(
      parseState({ attempted: { a: { at: 5, started: true }, b: { at: "x" }, c: 3 } }).attempted,
    ).toEqual({ a: { at: 5, started: true } });
  });

  test("reads a one-issue link from an older state.json as a list of one", () => {
    expect(parseState({ links: { s1: "5001" } }).links).toEqual({ s1: ["5001"] });
  });
});

describe("linkIssue and unlinkIssue", () => {
  test("a second issue joins the first instead of replacing it", () => {
    const state = { links: { s1: ["5001"] }, folders: {}, attempted: {} };
    linkIssue(state, "s1", "5002");
    linkIssue(state, "s1", "5002");
    expect(state.links).toEqual({ s1: ["5001", "5002"] });
  });

  test("unlinking the last issue forgets the session", () => {
    const state: State = { links: { s1: ["5001", "5002"] }, folders: {}, attempted: {} };
    unlinkIssue(state, "s1", "5001");
    expect(state.links).toEqual({ s1: ["5002"] });
    unlinkIssue(state, "s1", "5002");
    expect(state.links).toEqual({});
  });
});

describe("auth", () => {
  test("parseClirc reads the token, org and url from their sections", () => {
    const text = [
      "; sentry-cli",
      "[auth]",
      "token = sntryu_abc",
      "[defaults]",
      'org="acme"',
      "url=https://sentry.io/",
      "[other]",
      "token=not-this-one",
    ].join("\n");
    expect(parseClirc(text)).toEqual({
      token: "sntryu_abc",
      org: "acme",
      url: "https://sentry.io/",
    });
    expect(parseClirc("")).toEqual(noClirc);
  });

  test("looksLikeToken takes personal, org and legacy tokens and nothing with spaces", () => {
    expect(looksLikeToken(`sntryu_${"a".repeat(64)}`)).toBe(true);
    expect(looksLikeToken(`sntrys_${"b".repeat(40)}==`)).toBe(true);
    expect(looksLikeToken("f".repeat(64))).toBe(true);
    expect(looksLikeToken("my token is sntryu_abc")).toBe(false);
    expect(looksLikeToken("https://sentry.io/settings/")).toBe(false);
  });
});

describe("issues", () => {
  const issue = readIssue(rawIssue);

  test("readIssue takes counts as strings and fills what is missing", () => {
    expect(issue.count).toBe(84);
    expect(issue.project).toBe("shop");
    expect(issue.firstRelease).toBe("1.4.0");
    expect(issue.assignee).toBe("Ada Lovelace");
    const bare = readIssue({ id: 9 });
    expect(bare).toMatchObject({
      id: "9",
      title: "(untitled issue)",
      level: "error",
      status: "unresolved",
      count: 0,
    });
  });

  test("a release named by a commit SHA is cut to twelve characters", () => {
    expect(shortRelease("d8bc9c50c73dcc93ac3bdfb898879de60c1aa76d")).toBe("d8bc9c50c73d");
    expect(shortRelease("shop@1.5.2")).toBe("shop@1.5.2");
  });

  test("an issue that is already a session says which, and asks before another", () => {
    const face = issueFace(issue, false, NOW);
    expect(alreadyStarted(face, issue.shortId, [])).toBe(face);
    const session = { id: "s1", title: "Fix the basket KeyError", cwd: "/w", state: "idle" };
    const marked = alreadyStarted(face, issue.shortId, [session]);
    expect(marked).toMatchObject({
      key: "5001",
      started: true,
      detail: "SHOP-1A2 · Already a session: “Fix the basket KeyError”",
      input: { placeholder: "again" },
    });
    expect(marked.input?.title).toContain("Type “again” to start another one anyway.");
  });

  test("readNotes gives the notes only, oldest first", () => {
    expect(readNotes(rawIssue).map((note) => note.text)).toEqual(["first!", "seen after deploy"]);
  });

  test("columns follow Sentry's substatus, unknown ones landing in Ongoing", () => {
    expect(columnOf(issue)).toBe("escalating");
    expect(columnOf({ ...issue, substatus: "something_new" })).toBe("ongoing");
  });

  test("a card and a chip say what the issue is and offer to resolve it", () => {
    const face = issueFace(issue, false, NOW);
    expect(face).toMatchObject({
      key: "5001",
      group: "escalating",
      tone: "warning",
      stripes: ["orange"],
    });
    expect(face.detail).toBe("SHOP-1A2 · /api/checkout · 84 events · 3 users · 1h ago");
    expect(issueFace(issue, true, NOW).detail?.startsWith("shop SHOP-1A2")).toBe(true);
    // With bars, the culprit moves to its own line and the bars count the events.
    const spark = { period: "24h", counts: [0, 2, 5], total: 7 };
    const barred = issueFace(issue, false, NOW, [spark]);
    expect(barred.sub).toBe("/api/checkout");
    expect(barred.sparks).toEqual([spark]);
    expect(barred.detail).toBe("SHOP-1A2 · 3 users · 1h ago");
    expect(face.sub).toBe("");
    // A card with no folder found says so after the rest.
    expect(issueFace(issue, false, NOW, [], "no code mapping").detail).toBe(
      "SHOP-1A2 · /api/checkout · 84 events · 3 users · 1h ago · no code mapping",
    );
    const chip = issueChip(issue, NOW);
    expect(chip.label).toBe("SHOP-1A2: KeyError: 'basket'");
    expect(chip.url).toBe(issue.permalink);
    expect(chip.actions?.map((a) => a.id)).toEqual(["resolve", "ignore"]);
    const resolved = issueChip({ ...issue, status: "resolved", substatus: "" }, NOW);
    expect(resolved).toMatchObject({
      tone: "good",
      icon: "sentry",
      label: "SHOP-1A2 resolved: KeyError: 'basket'",
    });
    expect(statusActions({ ...issue, status: "ignored" }).map((a) => a.id)).toEqual(["unresolve"]);
  });

  test("the filter matches every word against title, culprit, id, level and project", () => {
    expect(matches(issue, "basket checkout")).toBe(true);
    expect(matches(issue, "shop-1a2")).toBe(true);
    expect(matches(issue, "basket warning")).toBe(false);
  });

  test("several projects sort as one list", () => {
    const a = { ...issue, id: "a", count: 5, lastSeen: "2026-09-25T00:00:00Z" };
    const b = { ...issue, id: "b", count: 50, lastSeen: "2026-09-24T00:00:00Z" };
    expect(sortIssues([b, a], "date").map((i) => i.id)).toEqual(["a", "b"]);
    expect(sortIssues([a, b], "freq").map((i) => i.id)).toEqual(["b", "a"]);
  });
});

describe("time", () => {
  test("when and ago", () => {
    expect(when("2026-09-25T11:00:59.9Z")).toBe("2026-09-25 11:00 UTC");
    expect(when("")).toBe("");
    expect(ago("2026-09-25T11:59:30Z", NOW)).toBe("30s");
    expect(ago("2026-09-25T11:00:00Z", NOW)).toBe("1h");
    expect(ago("2026-09-23T12:00:00Z", NOW)).toBe("2d");
    expect(ago("2026-01-01T00:00:00Z", NOW)).toBe("8mo");
  });
});
