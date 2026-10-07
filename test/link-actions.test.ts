import { expect, test } from "bun:test";
import { linkActions, withLinks } from "../link-actions";

const session = (id: string, state = "running") => ({ id, title: `Title ${id}`, cwd: "/x", state });

test("offers at most four, in list order", () => {
  const all = ["a", "b", "c", "d", "e", "f"].map((id) => session(id));
  const actions = linkActions(all, {}, "ISSUE");
  expect(actions.map((a) => a.id)).toEqual(["link:a", "link:b", "link:c", "link:d"]);
  expect(actions[0]).toEqual({ id: "link:a", label: "Link to session: Title a" });
});

test("skips ended sessions", () => {
  const actions = linkActions(
    [session("a", "ended"), session("b"), session("c", "ended")],
    {},
    "ISSUE",
  );
  expect(actions.map((a) => a.id)).toEqual(["link:b"]);
});

test("skips sessions already on this issue but not those on another", () => {
  const links = { a: "ISSUE", b: "OTHER" };
  const actions = linkActions([session("a"), session("b")], links, "ISSUE");
  expect(actions.map((a) => a.id)).toEqual(["link:b"]);
});

test("the four are counted after the skips", () => {
  const all = [
    session("x", "ended"),
    session("a"),
    session("b"),
    session("c"),
    session("d"),
    session("e"),
  ];
  expect(linkActions(all, { a: "ISSUE" }, "ISSUE").map((a) => a.id)).toEqual([
    "link:b",
    "link:c",
    "link:d",
    "link:e",
  ]);
});

test("links go between resolve and archive", () => {
  const menu = withLinks([{ id: "resolve" }, { id: "ignore" }], [{ id: "link:a" }]);
  expect(menu.map((a) => a.id)).toEqual(["resolve", "link:a", "ignore"]);
});

test("links go last when there is no archive row", () => {
  const menu = withLinks([{ id: "unresolve" }], [{ id: "link:a" }]);
  expect(menu.map((a) => a.id)).toEqual(["unresolve", "link:a"]);
});
