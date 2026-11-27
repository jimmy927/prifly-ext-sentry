/** Made up in the shapes Sentry's replay API returns; nothing here came from a real replay. */
export const rawReplay = {
  id: "0123456789abcdef0123456789abcdef",
  project_id: "42",
  started_at: "2026-11-27T14:29:50+00:00",
  finished_at: "2026-11-27T14:31:00+00:00",
  duration: 70,
  urls: ["https://app.example/todo"],
  user: { id: "1818", display_name: "1818", email: null },
  browser: { name: "Chrome", version: "131.0.0" },
  os: { name: "Windows", version: ">=10" },
  device: { brand: null, model: null },
  environment: "production",
  releases: ["abc123"],
  count_errors: 1,
  error_ids: ["e1"],
  count_segments: 2,
};

export const T0 = Date.parse("2026-11-27T14:29:50Z");

export const snapshot = {
  type: 0,
  id: 1,
  childNodes: [
    {
      type: 2,
      tagName: "html",
      id: 2,
      attributes: { lang: "en" },
      childNodes: [
        {
          type: 2,
          tagName: "body",
          id: 3,
          attributes: {},
          childNodes: [
            {
              type: 2,
              tagName: "span",
              id: 4,
              attributes: { class: "badge count" },
              childNodes: [{ type: 3, id: 5, textContent: "Assignments" }],
            },
          ],
        },
      ],
    },
  ],
};

export const segments = [
  [
    {
      type: 4,
      timestamp: T0,
      data: { href: "https://app.example/todo", width: 1280, height: 720 },
    },
    { type: 2, timestamp: T0 + 10, data: { node: snapshot } },
    {
      type: 5,
      timestamp: T0 + 20,
      data: { tag: "options", payload: { maskAllText: true } },
    },
    // A mouse move: left out.
    { type: 3, timestamp: T0 + 500, data: { source: 1, positions: [] } },
  ],
  [
    {
      type: 5,
      timestamp: T0 + 12_000,
      data: {
        tag: "performanceSpan",
        payload: {
          op: "resource.fetch",
          description: "https://app.example/api/v2/counts/",
          startTimestamp: (T0 + 12_000) / 1000,
          endTimestamp: (T0 + 12_250) / 1000,
          data: { method: "GET", statusCode: 200 },
        },
      },
    },
    {
      type: 5,
      timestamp: (T0 + 11_000) / 1000,
      data: {
        tag: "breadcrumb",
        payload: { category: "ui.click", message: "button.refresh" },
      },
    },
    // Google Translate: <html> gets translated-ltr and a new lang, text is wrapped in <font>.
    {
      type: 3,
      timestamp: T0 + 12_300,
      data: {
        source: 0,
        attributes: [{ id: 2, attributes: { class: "translated-ltr", lang: "sv" } }],
        adds: [
          {
            parentId: 4,
            node: {
              type: 2,
              tagName: "font",
              id: 6,
              attributes: { style: "vertical-align: inherit;" },
              childNodes: [],
            },
          },
        ],
        removes: [{ parentId: 4, id: 5 }],
        texts: [],
      },
    },
    {
      type: 3,
      timestamp: T0 + 12_400,
      data: { source: 0, adds: [], removes: [], attributes: [], texts: [{ id: 5, value: "x" }] },
    },
    {
      type: 5,
      timestamp: T0 + 13_000,
      data: {
        tag: "breadcrumb",
        payload: {
          category: "console",
          level: "error",
          message: "NotFoundError: Failed to execute 'removeChild' on 'Node'",
        },
      },
    },
  ],
];
