import { describe, expect, test } from "bun:test";
import { crumbLine, issuePrompt } from "../issue-prompt";
import { readIssue } from "../sentry";
import { messageEvent, NOW, pythonEvent, rawIssue } from "./fixtures";

const issue = readIssue(rawIssue);

function prompt(event: unknown, files: string[] = []): string {
  return issuePrompt({ issue, event, folder: "/ext/issues/SHOP-1A2", files, now: NOW });
}

describe("issuePrompt", () => {
  const text = prompt(pythonEvent, [
    "/ext/issues/SHOP-1A2/issue.json",
    "/ext/issues/SHOP-1A2/event-abc123.json",
  ]);

  test("opens with the title and where the issue lives", () => {
    expect(
      text.startsWith(
        "# KeyError: 'basket'\n\nhttps://example-org.sentry.io/issues/5001/ · SHOP-1A2 · project shop",
      ),
    ).toBe(true);
  });

  test("states the facts: level, status, culprit, counts, dates, releases, assignee", () => {
    expect(text).toContain("- Level: error · unresolved (escalating) · unhandled · python");
    expect(text).toContain("- Culprit: `/api/checkout`");
    expect(text).toContain("- Events: 84 · users affected: 3");
    expect(text).toContain("- First seen: 2026-09-20 08:00 UTC (5d ago)");
    expect(text).toContain("- Last seen: 2026-09-25 11:00 UTC (1h ago)");
    expect(text).toContain("- Releases: first 1.4.0 · last 1.5.2 · this event 1.5.2");
    expect(text).toContain("- Assigned to: Ada Lovelace");
    expect(text).toContain("- Latest event: abc123 at 2026-09-25 11:00 UTC");
  });

  test("carries the trace, the last fifteen breadcrumbs, the request, context and tags", () => {
    expect(text).toContain("## Exception\n\n### KeyError: 'basket'");
    expect(text).toContain("## Breadcrumbs (last 15 of 21, oldest first)");
    expect(text).toContain("10:59:59 error httplib  POST https://payments.example/charge → 502");
    expect(text).not.toContain("step 5\n");
    expect(text).toContain(
      "- POST https://shop.example/api/checkout\n- query: step=2\n- User-Agent: Mozilla/5.0",
    );
    expect(text).toContain('- body: {"coupon":"X"}');
    // Cookies stay out of a prompt.
    expect(text).not.toContain("secret");
    expect(text).toContain("- runtime: CPython 3.12.1");
    expect(text).toContain("- user: id 42 · someone@example.com · Oslo, NO");
    expect(text).not.toContain("trace:");
    expect(text).toContain("- environment: production");
  });

  test("points at the saved files and ends with what to do", () => {
    expect(text).toContain(
      "## Saved on disk\n\nIn /ext/issues/SHOP-1A2:\n- /ext/issues/SHOP-1A2/issue.json",
    );
    expect(text).toContain("event-abc123.json");
    expect(
      text
        .trimEnd()
        .endsWith("Do not resolve or ignore the issue in Sentry unless you are asked to."),
    ).toBe(true);
  });

  test("a message event says its message", () => {
    const said = prompt(messageEvent);
    expect(said).toContain("## Message\n\nbackup failed: disk full on /var/backups");
    expect(said).toContain("### Stack: backup failed");
    expect(said).not.toContain("## Saved on disk");
  });

  test("an issue whose event could not be read still makes a prompt", () => {
    const bare = prompt(null);
    expect(bare).toContain("- Events: 84");
    expect(bare).not.toContain("## Exception");
    expect(bare).not.toContain("Latest event");
  });
});

describe("crumbLine", () => {
  test("falls back from message to HTTP to data", () => {
    const base = { timestamp: "2026-09-25T10:00:01Z", level: "", category: "", type: "default" };
    expect(crumbLine({ ...base, message: "hi", data: {} })).toBe("10:00:01 info default  hi");
    expect(crumbLine({ ...base, message: "", data: { url: "/x", method: "GET" } })).toBe(
      "10:00:01 info default  GET /x",
    );
    expect(crumbLine({ ...base, message: "", data: { a: 1 } })).toBe(
      '10:00:01 info default  {"a":1}',
    );
    expect(crumbLine({ ...base, message: "", data: {} })).toBe("10:00:01 info default");
  });
});
