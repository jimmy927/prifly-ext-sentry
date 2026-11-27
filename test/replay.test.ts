import { describe, expect, test } from "bun:test";
import { markerOf } from "../dom";
import { eventsOf, readReplay, replayIdOf, replayText, timeline } from "../replay";
import { rawReplay, segments, snapshot, T0 } from "./replay-fixtures";

describe("replayIdOf", () => {
  test("takes an id, a dashed id or a replay URL", () => {
    const id = "00dfa377ada54cfba13bf33f41352257";
    expect(replayIdOf(id)).toBe(id);
    expect(replayIdOf("00dfa377-ada5-4cfb-a13b-f33f41352257")).toBe(id);
    expect(replayIdOf(`https://acme.sentry.io/replays/${id}/?referrer=issue`)).toBe(id);
    expect(replayIdOf(`https://acme.sentry.io/explore/replays/${id}/`)).toBe(id);
    expect(replayIdOf("PROJ-1A2")).toBe("");
  });
});

describe("readReplay", () => {
  test("reads the facts a person looks at", () => {
    const facts = readReplay(rawReplay);
    expect(facts.projectId).toBe("42");
    expect(facts.user).toBe("1818 · id 1818");
    expect(facts.browser).toBe("Chrome 131.0.0");
    expect(facts.device).toBe("");
    expect(facts.errorIds).toEqual(["e1"]);
  });
});

describe("timeline", () => {
  const lines = timeline(eventsOf(segments)).map((line) => line.text);

  test("tells page, snapshot, click, fetch, DOM and console in time order", () => {
    expect(lines[0]).toBe("page  https://app.example/todo  (1280×720)");
    expect(lines[1]).toStartWith('DOM snapshot  <html lang="en">');
    expect(lines[2]).toBe("recording options  all text masked (shown as *)");
    expect(lines[3]).toBe("click  button.refresh");
    expect(lines[4]).toBe("fetch  GET https://app.example/api/v2/counts/ → 200 (250 ms)");
    expect(lines[5]).toStartWith("DOM  +1 nodes, −1 nodes, 1 text, 1 attribute  ⚑");
    expect(lines[6]).toContain("console.error  NotFoundError");
    expect(lines).toHaveLength(7);
  });

  test("flags the translator and quotes what changed on <html>", () => {
    const dom = lines[5] ?? "";
    expect(dom).toContain(
      "⚑ Google Translate (<font> around text) ×1; Google Translate (translated-ltr on the page) ×1",
    );
    expect(dom).toContain('<html> class: "" → "translated-ltr", lang: "en" → "sv"');
    expect(dom).toContain("added span.badge.count > font");
  });

  test("mutations within a second are one line, and mouse moves are left out", () => {
    expect(lines.filter((line) => line.startsWith("DOM  "))).toHaveLength(1);
    expect(lines.some((line) => line.includes("positions"))).toBe(false);
  });

  test("a text change quotes before and after", () => {
    const events = eventsOf([
      [
        { type: 2, timestamp: T0, data: { node: snapshot } },
        {
          type: 3,
          timestamp: T0 + 5,
          data: { source: 0, texts: [{ id: 5, value: "Uppdrag" }] },
        },
      ],
    ]);
    const told = timeline(events).map((line) => line.text);
    expect(told[1]).toContain('text in body > span.badge.count: "Assignments" → "Uppdrag"');
  });
});

describe("replayText", () => {
  test("a header, then the timeline with offsets and UTC times", () => {
    const out = replayText(readReplay(rawReplay), eventsOf(segments), {
      around: null,
      window: 30,
      limit: 400,
    });
    expect(out).toStartWith("# Replay 0123456789abcdef0123456789abcdef");
    expect(out).toContain("user: 1818 · id 1818 · Chrome 131.0.0 · Windows >=10");
    expect(out).toContain("+0:12.000  14:30:02.000  fetch  GET");
  });

  test("around narrows it, and a limit says it cut", () => {
    const facts = readReplay(rawReplay);
    const near = replayText(facts, eventsOf(segments), {
      around: T0 + 11_000,
      window: 1,
      limit: 400,
    });
    expect(near).toContain("1 s either side of 2026-11-27T14:30:01.000Z");
    expect(near).toContain("click  button.refresh");
    expect(near).toContain("fetch  GET");
    expect(near).not.toContain("console.error");
    const cut = replayText(facts, eventsOf(segments), { around: null, window: 30, limit: 2 });
    expect(cut).toContain("… 7 lines in all; cut at 2.");
  });
});

describe("markerOf", () => {
  test("knows the usual extensions and leaves the page's own nodes alone", () => {
    expect(markerOf("div", { _msttexthash: "123" })).toBe("Microsoft (Edge) Translator");
    expect(markerOf("body", { "data-new-gr-c-s-check-loaded": "14" })).toBe("Grammarly");
    expect(markerOf("div", { id: "goog-gt-tt" })).toBe("Google Translate (its widget)");
    expect(markerOf("script", { src: "chrome-extension://abc/x.js" })).toContain("an extension");
    expect(markerOf("div", { class: "card" })).toBe("");
    expect(markerOf("span", {})).toBe("");
  });
});
