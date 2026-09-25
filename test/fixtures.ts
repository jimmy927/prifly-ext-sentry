/**
 * Made-up Sentry payloads in the shapes Sentry's API returns (checked against
 * real ones from sentry.io, 2026-09): nothing here came from a real event.
 */

export const NOW = Date.parse("2026-09-25T12:00:00Z");

function frame(
  filename: string,
  fn: string,
  line: number,
  inApp: boolean,
  extra: Record<string, unknown> = {},
) {
  return {
    filename,
    absPath: `/code/${filename}`,
    module: filename.replace(/\.py$/, "").replaceAll("/", "."),
    function: fn,
    lineNo: line,
    colNo: null,
    inApp,
    context: [[line, `    call_${fn}()`]],
    vars: null,
    ...extra,
  };
}

const library = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    frame(`django/core/handlers/h${i}.py`, `inner${i}`, 10 + i, false),
  );

export const rawIssue = {
  id: "5001",
  shortId: "SHOP-1A2",
  title: "KeyError: 'basket'",
  culprit: "/api/checkout",
  permalink: "https://example-org.sentry.io/issues/5001/",
  level: "error",
  status: "unresolved",
  substatus: "escalating",
  platform: "python",
  project: { id: "7", slug: "shop", name: "shop" },
  count: "84",
  userCount: 3,
  firstSeen: "2026-09-20T08:00:00Z",
  lastSeen: "2026-09-25T11:00:00Z",
  numComments: 2,
  assignedTo: { type: "user", id: "1", name: "Ada Lovelace" },
  isUnhandled: true,
  firstRelease: { version: "shop@1.4.0", shortVersion: "1.4.0" },
  lastRelease: { version: "shop@1.5.2", shortVersion: "1.5.2" },
  activity: [
    {
      type: "note",
      user: { name: "Grace" },
      dateCreated: "2026-09-24T10:00:00Z",
      data: { text: "seen after deploy" },
    },
    { type: "set_regression", data: {} },
    {
      type: "note",
      user: { name: "Ada" },
      dateCreated: "2026-09-21T10:00:00Z",
      data: { text: "first!" },
    },
  ],
};

const crumbs: Record<string, unknown>[] = Array.from({ length: 20 }, (_, i) => ({
  type: "default",
  timestamp: `2026-09-25T10:59:${String(i).padStart(2, "0")}.000Z`,
  level: "info",
  message: `step ${i}`,
  category: "app",
  data: null,
}));
crumbs.push({
  type: "http",
  timestamp: "2026-09-25T10:59:59.000Z",
  level: "error",
  message: null,
  category: "httplib",
  data: {
    method: "POST",
    url: "https://payments.example/charge",
    status_code: 502,
  },
});

export const pythonEvent = {
  eventID: "abc123",
  dateCreated: "2026-09-25T11:00:00Z",
  message: "",
  release: { version: "shop@1.5.2", shortVersion: "1.5.2" },
  user: { id: "42", email: "someone@example.com", geo: { city: "Oslo", country_code: "NO" } },
  contexts: {
    runtime: { name: "CPython", version: "3.12.1", type: "runtime" },
    browser: { name: "Firefox", version: "130.0", type: "browser" },
    trace: { trace_id: "t", type: "trace" },
  },
  tags: [
    { key: "environment", value: "production" },
    { key: "release", value: "shop@1.5.2" },
  ],
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "ConnectionError",
            value: "payments unreachable",
            mechanism: { type: "django", handled: true },
            stacktrace: { frames: [frame("shop/payments.py", "charge", 30, true)] },
          },
          {
            type: "KeyError",
            value: "'basket'",
            mechanism: { type: "django", handled: false },
            stacktrace: {
              frames: [
                ...library(4),
                frame("shop/views.py", "checkout", 55, true),
                ...library(3),
                frame("shop/basket.py", "load", 12, true, {
                  context: [
                    [10, "def load(session):"],
                    [11, "    data = session.data"],
                    [12, "    return data['basket']"],
                    [13, ""],
                  ],
                  vars: { session: "<Session 9>", data: { user: 42 } },
                }),
                frame("django/utils/datastructures.py", "__getitem__", 80, false),
              ],
            },
          },
        ],
      },
    },
    { type: "breadcrumbs", data: { values: crumbs } },
    {
      type: "request",
      data: {
        method: "POST",
        url: "https://shop.example/api/checkout",
        query: [["step", "2"]],
        headers: [
          ["User-Agent", "Mozilla/5.0"],
          ["Cookie", "secret"],
        ],
        data: { coupon: "X" },
      },
    },
  ],
};

/** A logged message with a thread's stack instead of an exception. */
export const messageEvent = {
  eventID: "def456",
  dateCreated: "2026-09-25T09:00:00Z",
  release: null,
  tags: [],
  contexts: {},
  entries: [
    { type: "message", data: { formatted: "backup failed: disk full on /var/backups" } },
    {
      type: "threads",
      data: {
        values: [
          { id: 1, current: false, stacktrace: { frames: [frame("other.py", "idle", 1, false)] } },
          {
            id: 2,
            current: true,
            stacktrace: { frames: [frame("jobs/backup.py", "run", 99, true)] },
          },
        ],
      },
    },
  ],
};
