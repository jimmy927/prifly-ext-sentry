import { describe, expect, test } from "bun:test";
import { launcherFlag } from "../issue-face";
import { type Issue, readIssue } from "../sentry";
import { rawIssue } from "./fixtures";

const base = readIssue(rawIssue);

function issue(level: string, status = "unresolved", id = `${level}-${status}`): Issue {
  return { ...base, id, level, status };
}

describe("launcherFlag", () => {
  test("red while any open issue is an error or a fatal", () => {
    expect(launcherFlag([issue("warning"), issue("error"), issue("fatal")])).toEqual({
      tone: "critical",
      hint: "2 open errors",
    });
  });

  test("orange while the open ones are only warnings or info", () => {
    expect(launcherFlag([issue("warning"), issue("info"), issue("error", "resolved")])).toEqual({
      tone: "warning",
      hint: "2 open warnings",
    });
  });

  test("counts only the open issues no session is working on", () => {
    const issues = [issue("error", "unresolved", "a"), issue("error", "unresolved", "b")];
    expect(launcherFlag(issues, new Set(["a"]))).toEqual({
      tone: "critical",
      hint: "1 open error",
    });
    expect(launcherFlag([...issues, issue("warning")], new Set(["a", "b"]))).toEqual({
      tone: "warning",
      hint: "1 open warning",
    });
  });

  test("blue once every open issue has a session", () => {
    const issues = [issue("fatal", "unresolved", "a"), issue("warning", "unresolved", "b")];
    expect(launcherFlag([...issues, issue("debug")], new Set(["a", "b"]))).toEqual({
      tone: "info",
      hint: "2 open issues, all with a session",
    });
  });

  test("out when nothing is open, or only debug", () => {
    expect(launcherFlag([])).toBeNull();
    expect(launcherFlag([issue("error", "ignored"), issue("debug")])).toBeNull();
  });
});
