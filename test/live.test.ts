/**
 * Against the real Sentry, read-only: GET requests and nothing else. Skipped
 * unless a token and a project are given:
 *
 *     SENTRY_AUTH_TOKEN=sntryu_… SENTRY_LIVE_ORG=acme SENTRY_LIVE_PROJECT=web bun test live
 */

import { describe, expect, test } from "bun:test";
import { exceptions } from "../event";
import { issuePrompt } from "../issue-prompt";
import {
  issueDetail,
  latestEvent,
  organizations,
  projectIssues,
  projects,
  readNotes,
  whoami,
} from "../sentry";

const token = Bun.env["SENTRY_AUTH_TOKEN"] ?? "";
const org = Bun.env["SENTRY_LIVE_ORG"] ?? "";
const project = Bun.env["SENTRY_LIVE_PROJECT"] ?? "";
const creds = { baseUrl: Bun.env["SENTRY_URL"] ?? "https://sentry.io", token };
const skip = token === "" || org === "" || project === "";

describe.skipIf(skip)("live Sentry (GET only)", () => {
  test("whoami, organizations and projects", async () => {
    expect(await whoami(creds)).not.toBe("");
    expect((await organizations(creds)).map((entry) => entry.slug)).toContain(org);
    expect((await projects(creds, org)).map((entry) => entry.slug)).toContain(project);
  }, 60_000);

  test("every listed issue reads, and the first few make a prompt from their latest event", async () => {
    for (const sort of ["date", "freq"] as const) {
      const issues = await projectIssues(creds, org, project, {
        query: "is:unresolved",
        period: "14d",
        sort,
        limit: 25,
      });
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.id).not.toBe("");
        expect(issue.shortId).not.toBe("");
        expect(issue.project).toBe(project);
        expect(issue.permalink.startsWith("https://")).toBe(true);
      }
      for (const listed of issues.slice(0, 5)) {
        const [detail, event] = await Promise.all([
          issueDetail(creds, org, listed.id),
          latestEvent(creds, org, listed.id),
        ]);
        readNotes(detail.raw);
        const text = issuePrompt({
          issue: detail.issue,
          event,
          folder: "/tmp/x",
          files: [],
          now: Date.now(),
        });
        expect(text.startsWith(`# ${detail.issue.title}`)).toBe(true);
        expect(text).toContain(`- Events: ${detail.issue.count}`);
        if (exceptions(event).length > 0) expect(text).toContain("## Exception");
      }
    }
  }, 120_000);
});
