import { describe, expect, test } from "bun:test";
import { launcherFlag } from "../issue-face";
import { type Issue, readIssue } from "../sentry";
import { rawIssue } from "./fixtures";

const base = readIssue(rawIssue);

function issue(level: string, status = "unresolved"): Issue {
  return { ...base, level, status };
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

  test("out when nothing is open, or only debug", () => {
    expect(launcherFlag([])).toBeNull();
    expect(launcherFlag([issue("error", "ignored"), issue("debug")])).toBeNull();
  });
});
