import { expect, test } from "bun:test";
import { LINK_ACTION, withLink } from "../link-actions";

test("the link row opens the session picker", () => {
  expect(LINK_ACTION).toEqual({ id: "link", label: "Link to session…", pick: "session" });
});

test("the link row goes between resolve and archive", () => {
  const menu = withLink([{ id: "resolve" }, { id: "ignore" }], { id: "link" });
  expect(menu.map((a) => a.id)).toEqual(["resolve", "link", "ignore"]);
});

test("the link row goes last when there is no archive row", () => {
  const menu = withLink([{ id: "unresolve" }], { id: "link" });
  expect(menu.map((a) => a.id)).toEqual(["unresolve", "link"]);
});
