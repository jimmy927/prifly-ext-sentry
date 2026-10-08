import { describe, expect, test } from "bun:test";
import type { ExtensionApi } from "../prifly-api";
import { SentryError } from "../sentry";
import { setupChoices, tokenPageMessage } from "../setup";
import type { World } from "../world";

function fakeWorld(): World {
  const api: ExtensionApi = {
    show: () => undefined,
    onAction: () => undefined,
    sessions: () => [],
    log: () => undefined,
    folder: "/tmp/fake-sentry-ext",
    paths: [],
  };
  return {
    api,
    config: {
      org: "",
      baseUrl: "https://sentry.io",
      projects: {},
      query: "is:unresolved",
      period: "14d",
      sort: "date",
      refreshSeconds: 120,
      startSessions: { enabled: false, levels: ["fatal", "error"], maxPerDay: 10, maxAgeHours: 24 },
    },
    login: null,
    state: { links: {}, folders: {}, linkedAt: {}, attempted: {} },
    issues: [],
    mappings: [],
    loadedAt: 0,
    linked: new Map(),
    sparks: new Map(),
  };
}

describe("login rows tell the reader what to pick", () => {
  test("the first row lists every permission, in the order Sentry's page shows them", async () => {
    const rows = await setupChoices(fakeWorld());
    const open = rows?.find((row) => row.key === "setup:open-token-page");
    const detail = open?.detail ?? "";
    const order = [
      "Name: prifly",
      "Project: Read",
      "Team: No Access",
      "Release: No Access",
      "Issue & Event: Read & Write",
      "Organization: Read",
      "Member: No Access",
      "Alerts: No Access",
    ];
    let cursor = -1;
    for (const phrase of order) {
      const at = detail.indexOf(phrase);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("Read & Write says why, so a reader happy with read-only knows what they lose", () => {
    const rows = tokenPageMessage(true, "https://sentry.io/settings/account/api/auth-tokens/");
    expect(rows).toContain("Resolve/Archive/Unresolve then fail with 403");
  });

  test("the message shown after opening the page repeats the same list", () => {
    const opened = tokenPageMessage(true, "https://sentry.io/settings/account/api/auth-tokens/");
    expect(opened).toContain("Project: Read");
    expect(opened).toContain("Organization: Read");
    expect(opened).toMatch(/Then pick .2\. Paste the token.\.$/);

    const notOpened = tokenPageMessage(
      false,
      "https://sentry.io/settings/account/api/auth-tokens/",
    );
    expect(notOpened).toContain("https://sentry.io/settings/account/api/auth-tokens/");
    expect(notOpened).toContain("Project: Read");
  });
});

describe("SentryError names the permission a 403 is missing", () => {
  test("listing organizations or the token check need Organization: Read", () => {
    expect(new SentryError("GET", "/organizations/", 403, "").message).toContain(
      "Organization: Read",
    );
    expect(new SentryError("GET", "/auth/", 403, "").message).toContain("Organization: Read");
  });

  test("listing projects needs Project: Read", () => {
    expect(new SentryError("GET", "/organizations/acme/projects/", 403, "").message).toContain(
      "Project: Read",
    );
  });

  test("reading an issue or event needs Issue & Event: Read", () => {
    const message = new SentryError("GET", "/organizations/acme/issues/123/events/latest/", 403, "")
      .message;
    expect(message).toContain("Issue & Event: Read");
    expect(message).not.toContain("Read & Write");
  });

  test("changing an issue's status needs Issue & Event: Read & Write", () => {
    expect(new SentryError("PUT", "/organizations/acme/issues/123/", 403, "").message).toContain(
      "Issue & Event: Read & Write",
    );
  });

  test("401 and other statuses are unchanged", () => {
    expect(new SentryError("GET", "/auth/", 401, "").message).toBe(
      "Sentry refused the token (401). Log in again from “From a Sentry issue…”.",
    );
    expect(new SentryError("GET", "/organizations/acme/issues/1/", 500, "boom").message).toBe(
      "Sentry /organizations/acme/issues/1/: 500 boom",
    );
  });
});
