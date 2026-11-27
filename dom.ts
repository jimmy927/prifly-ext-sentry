/**
 * The page a session replay recorded, rebuilt far enough to say what changed.
 *
 * A replay's recording is rrweb's: one full snapshot of the DOM (every node
 * serialized with a numeric id), then incremental mutations that add, remove,
 * retext and re-attribute nodes by those ids. `Dom` keeps each node's tag,
 * attributes, text and parent, so a mutation can be told as "`span` 'Inbox'
 * → 'Inkorg'" rather than "node 812".
 *
 * It also looks for what a browser extension or a built-in translator leaves
 * behind (`markerOf`): Chrome's Google Translate wraps text in `<font>` and
 * sets `class="translated-ltr"` and a new `lang` on `<html>`; Edge's
 * translator sets `_msttexthash`; Grammarly, password managers, Dark Reader
 * and the like add attributes or elements of their own. A recording made
 * with text masked still shows all of these: only the text is starred.
 */

import { arr, clip, type Json, num, obj, str } from "./read";

type Node = {
  parent: number;
  /** Lower-case tag for an element; "#text" for text; "#doc" and the like for the rest. */
  tag: string;
  attrs: Record<string, string>;
  text: string;
};

/** rrweb's serialized node types. */
const DOCUMENT = 0;
const ELEMENT = 2;
const TEXT = 3;

/** Attribute names that only an extension or a translator sets, as prefix → who. */
const ATTRIBUTE_MARKERS: [RegExp, string][] = [
  [/^_mst/, "Microsoft (Edge) Translator"],
  [/^_istranslated$/, "Microsoft (Edge) Translator"],
  [/^data-immersive-translate/, "Immersive Translate"],
  [/^data-deepl/, "DeepL"],
  [/^data-gr-|^data-new-gr-c-s/, "Grammarly"],
  [/^data-lastpass/, "LastPass"],
  [/^data-dashlane/, "Dashlane"],
  [/^data-1p-|^data-op-/, "1Password"],
  [/^data-bitwarden/, "Bitwarden"],
  [/^data-darkreader/, "Dark Reader"],
  [/^cz-shortcut-listen$/, "ColorZilla"],
  [/^bis_/, "an extension (bis_* attributes)"],
  [/^data-ms-editor$/, "Microsoft Editor"],
];

/** Tags only an extension or a translator adds. `font` is Google Translate's wrapper. */
const TAG_MARKERS: Record<string, string> = {
  font: "Google Translate (<font> around text)",
  "grammarly-extension": "Grammarly",
  "grammarly-desktop-integration": "Grammarly",
  "deepl-input-controller": "DeepL",
  "immersive-translate": "Immersive Translate",
  "loom-container": "Loom",
};

/** Class or id fragments a translator's own widgets carry. */
const NAME_MARKERS: [RegExp, string][] = [
  [/\btranslated-(ltr|rtl)\b/, "Google Translate (translated-ltr on the page)"],
  [/\bgoog-te-|\bgoog-gt-|\bskiptranslate\b/, "Google Translate (its widget)"],
  [/\bimmersive-translate/, "Immersive Translate"],
];

/** What a node's tag or attributes say about who put it there; "" when nothing. */
export function markerOf(tag: string, attrs: Record<string, string>): string {
  const byTag = TAG_MARKERS[tag];
  if (byTag !== undefined) return byTag;
  for (const name of Object.keys(attrs)) {
    const hit = ATTRIBUTE_MARKERS.find(([pattern]) => pattern.test(name));
    if (hit !== undefined) return hit[1];
  }
  const names = `${attrs["class"] ?? ""} ${attrs["id"] ?? ""}`;
  const named = NAME_MARKERS.find(([pattern]) => pattern.test(names));
  if (named !== undefined) return named[1];
  const source = attrs["src"] ?? attrs["href"] ?? "";
  if (/^(chrome|moz|safari-web)-extension:\/\//.test(source))
    return `an extension (${clip(source, 60)})`;
  if (/translate\.(googleapis|google)\.com/.test(source)) return "Google Translate (its script)";
  return "";
}

/** Attribute values as text; rrweb sends a style change as an object, and a removal as null. */
function attributes(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(obj(raw))) {
    if (value === null) continue;
    out[name] = typeof value === "object" ? JSON.stringify(value) : str(value);
  }
  return out;
}

/** What one batch of mutations did, told for a person. */
export type Change = {
  added: number;
  removed: number;
  texts: number;
  attributes: number;
  /** Extension or translator traces, each with how often it was seen. */
  markers: Map<string, number>;
  /** A few lines worth quoting: text before → after, `<html>` attributes changed, marker nodes added. */
  samples: string[];
};

export function emptyChange(): Change {
  return { added: 0, removed: 0, texts: 0, attributes: 0, markers: new Map(), samples: [] };
}

const SAMPLES = 6;

function note(change: Change, marker: string, sample: string): void {
  if (marker !== "") change.markers.set(marker, (change.markers.get(marker) ?? 0) + 1);
  if (sample !== "" && change.samples.length < SAMPLES && !change.samples.includes(sample)) {
    change.samples.push(sample);
  }
}

export class Dom {
  private nodes = new Map<number, Node>();

  /** A full snapshot replaces the page; returns what it holds of note. */
  snapshot(root: unknown): Change {
    this.nodes.clear();
    const change = emptyChange();
    this.add(root, -1, change);
    change.added = 0;
    return change;
  }

  /** `<html>`'s attributes, as the page has them now: lang, class, dir. */
  htmlAttributes(): Record<string, string> {
    for (const node of this.nodes.values()) if (node.tag === "html") return node.attrs;
    return {};
  }

  /** One rrweb mutation (incremental source 0), applied and told into `change`. */
  mutate(data: Json, change: Change): void {
    for (const raw of arr(data["removes"]).map(obj)) {
      change.removed += 1;
      this.drop(num(raw["id"]));
    }
    for (const raw of arr(data["adds"]).map(obj)) {
      change.added += 1;
      const node = obj(raw["node"]);
      this.add(node, num(raw["parentId"]), change);
    }
    for (const raw of arr(data["texts"]).map(obj)) this.retext(raw, change);
    for (const raw of arr(data["attributes"]).map(obj)) this.reattribute(raw, change);
  }

  private add(raw: unknown, parent: number, change: Change): void {
    const node = obj(raw);
    const id = num(node["id"]);
    const type = num(node["type"]);
    const tag =
      type === ELEMENT
        ? str(node["tagName"]).toLowerCase()
        : type === TEXT
          ? "#text"
          : type === DOCUMENT
            ? "#doc"
            : "#other";
    const attrs = attributes(node["attributes"]);
    this.nodes.set(id, { parent, tag, attrs, text: str(node["textContent"]) });
    if (type === ELEMENT) {
      const marker = markerOf(tag, attrs);
      note(change, marker, marker === "" ? "" : `added ${this.describe(id)}`);
    }
    for (const child of arr(node["childNodes"])) this.add(child, id, change);
  }

  private drop(id: number): void {
    this.nodes.delete(id);
  }

  private retext(raw: Json, change: Change): void {
    change.texts += 1;
    const node = this.nodes.get(num(raw["id"]));
    const after = str(raw["value"]);
    if (node === undefined) return;
    const before = node.text;
    node.text = after;
    if (before.trim() === after.trim()) return;
    const parent = this.nodes.get(node.parent);
    const inside = parent === undefined ? "text" : this.describe(node.parent);
    note(change, "", `text in ${inside}: ${quote(before)} → ${quote(after)}`);
  }

  private reattribute(raw: Json, change: Change): void {
    change.attributes += 1;
    const id = num(raw["id"]);
    const node = this.nodes.get(id);
    const set = obj(raw["attributes"]);
    if (node === undefined) return;
    const before = { ...node.attrs };
    for (const [name, value] of Object.entries(set)) {
      if (value === null) delete node.attrs[name];
      else node.attrs[name] = typeof value === "object" ? JSON.stringify(value) : str(value);
    }
    const marker =
      markerOf(node.tag, set as Record<string, string>) || markerOf(node.tag, node.attrs);
    const told = Object.entries(set)
      .map(
        ([name, value]) =>
          `${name}: ${quote(before[name] ?? "")} → ${quote(value === null ? "(removed)" : str(value))}`,
      )
      .join(", ");
    // The page's own class flips are noise; `<html>`'s attributes and a translator's are not.
    if (node.tag === "html" || marker !== "") note(change, marker, `<${node.tag}> ${told}`);
  }

  /** A node as a person would point at it: `span.badge#count`, `<font>`, or its tag. */
  describe(id: number): string {
    const node = this.nodes.get(id);
    if (node === undefined) return `node ${id}`;
    const parent = this.nodes.get(node.parent);
    return parent === undefined || parent.tag.startsWith("#")
      ? selector(node)
      : `${selector(parent)} > ${selector(node)}`;
  }

  /** Every marker node on the page now, for a snapshot's summary. */
  markers(): Map<string, number> {
    const found = new Map<string, number>();
    for (const node of this.nodes.values()) {
      if (node.tag.startsWith("#")) continue;
      const marker = markerOf(node.tag, node.attrs);
      if (marker !== "") found.set(marker, (found.get(marker) ?? 0) + 1);
    }
    return found;
  }
}

/** `span#count.badge.big`: the tag, its id, and its first two classes. */
function selector(node: Node): string {
  const classes = (node.attrs["class"] ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const id = node.attrs["id"] ? `#${node.attrs["id"]}` : "";
  return `${node.tag}${id}${classes.map((one) => `.${one}`).join("")}`;
}

function quote(text: string): string {
  return JSON.stringify(clip(text.replace(/\s+/g, " ").trim(), 60));
}
