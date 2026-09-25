import { describe, expect, test } from "bun:test";
import { exceptions, type Frame } from "../event";
import { frameLine, renderChain, renderFrames, trimFrames } from "../stack";
import { messageEvent, pythonEvent } from "./fixtures";

function frame(name: string, inApp: boolean, line = 1): Frame {
  return {
    filename: `${name}.py`,
    function: name,
    module: name,
    lineNo: line,
    colNo: 0,
    inApp,
    context: [[line, `code_of_${name}()`]],
    vars: null,
  };
}

const shape = (kept: ReturnType<typeof trimFrames>) =>
  kept.map((entry) => ("folded" in entry ? `…${entry.folded}` : entry.frame.function));

describe("trimFrames", () => {
  test("keeps in-app frames and the raising frame, folding library runs", () => {
    const frames = [
      frame("lib1", false),
      frame("lib2", false),
      frame("app1", true),
      frame("lib3", false),
      frame("app2", true),
      frame("lib4", false),
      frame("raiser", false),
    ];
    expect(shape(trimFrames(frames))).toEqual(["…2", "app1", "…1", "app2", "…1", "raiser"]);
  });

  test("with no in-app frame at all, keeps the innermost eight", () => {
    const frames = Array.from({ length: 12 }, (_, i) => frame(`lib${i}`, false));
    expect(shape(trimFrames(frames))).toEqual([
      "…4",
      "lib4",
      "lib5",
      "lib6",
      "lib7",
      "lib8",
      "lib9",
      "lib10",
      "lib11",
    ]);
  });

  test("caps the kept frames at the innermost `max`", () => {
    const frames = Array.from({ length: 10 }, (_, i) => frame(`app${i}`, true));
    expect(shape(trimFrames(frames, 3))).toEqual(["…7", "app7", "app8", "app9"]);
  });

  test("an empty trace stays empty", () => {
    expect(trimFrames([])).toEqual([]);
  });
});

describe("renderFrames", () => {
  test("gives the innermost in-app frame its source and locals, marked", () => {
    const chain = exceptions(pythonEvent);
    const raised = chain.at(-1);
    expect(raised?.type).toBe("KeyError");
    const text = renderFrames(raised?.frames ?? []);
    expect(text).toContain("shop/basket.py:12 in load");
    expect(text).toContain(">    12 |     return data['basket']");
    expect(text).toContain("session = <Session 9>");
    expect(text).toContain('data = {"user":42}');
    expect(text).toContain("… 4 library frames …");
    expect(text).toContain("django/utils/datastructures.py:80 in __getitem__  [library]");
    // An outer in-app frame gets only its own line, not the whole block.
    expect(text).toContain("shop/views.py:55 in checkout\n      call_checkout()");
  });

  test("frameLine says where a frame is", () => {
    expect(frameLine(frame("x", true, 7))).toBe("x.py:7 in x");
    expect(frameLine({ ...frame("y", false, 0), function: "" })).toBe("y.py  [library]");
    expect(
      frameLine({
        ...frame("h", true, 45),
        filename: "../../../../frontend/api/fetch.ts",
        colNo: 24,
      }),
    ).toBe("frontend/api/fetch.ts:45:24 in h");
  });
});

describe("renderChain", () => {
  test("puts the raised exception first and its cause after", () => {
    const text = renderChain(exceptions(pythonEvent));
    const raised = text.indexOf("### KeyError: 'basket'");
    const cause = text.indexOf("### Caused by ConnectionError: payments unreachable");
    expect(raised).toBeGreaterThanOrEqual(0);
    expect(cause).toBeGreaterThan(raised);
    expect(text).toContain("mechanism django, unhandled");
  });

  test("a message event's current thread stands in for an exception", () => {
    const chain = exceptions(messageEvent);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.value).toBe("backup failed: disk full on /var/backups");
    expect(renderChain(chain)).toContain("jobs/backup.py:99 in run");
  });
});
