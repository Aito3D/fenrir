import { STACK_DIMENSIONS, type StackDimension } from "./chart";
import { RANGE_PRESETS } from "./buckets";
import { isCustomerSegment, isRevenueGranularity, isRevenueKind, isRevenueView, type RangeChoice, type RevenueView } from "./dashboard";
import { isValidDay } from "./dates";
import { ITEM_ID_RE, brandKey } from "./products";
import type { CustomerSegment, RangePresetId, RevenueGranularity, RevenueKind, TaxMode } from "./types";

/**
 * The revenue page's controls on its own URL, so a view can be bookmarked or sent
 * (`?g=week&tax=ttc&preset=all&kind=services&segment=pro&brand=eSUN&items=1,2&view=clients`).
 * Pure: the page reads it once after mount (the URL wins over localStorage) and writes it back
 * with `history.replaceState`. A value that does not validate is dropped, never guessed.
 */
export interface UrlControls {
  granularity?: RevenueGranularity;
  taxMode?: TaxMode;
  stack?: StackDimension;
  range?: RangeChoice;
  kind?: RevenueKind;
  segment?: CustomerSegment;
  view?: RevenueView;
  /** Folded brand keys. */
  brands?: string[];
  /** Basket item ids; the page resolves them against the products list once it loads. */
  items?: string[];
}

const MAX_URL_ITEMS = 50;
const MAX_BRAND_LENGTH = 64;
const MAX_BRAND_FILTERS = 50;

export function controlsFromSearch(search: string): UrlControls {
  const sp = new URLSearchParams(search);
  const out: UrlControls = {};
  const g = sp.get("g");
  if (isRevenueGranularity(g)) out.granularity = g;
  const tax = sp.get("tax");
  if (tax === "ht" || tax === "ttc") out.taxMode = tax;
  const stack = sp.get("stack");
  if (STACK_DIMENSIONS.some((d) => d.id === stack)) out.stack = stack as StackDimension;
  const from = sp.get("from");
  const to = sp.get("to");
  const preset = sp.get("preset");
  if (from && to && isValidDay(from) && isValidDay(to) && from <= to) out.range = { preset: "custom", from, to };
  else if (RANGE_PRESETS.some((p) => p.id === preset)) out.range = { preset: preset as RangePresetId };
  const kind = sp.get("kind");
  if (isRevenueKind(kind)) out.kind = kind;
  const segment = sp.get("segment");
  if (isCustomerSegment(segment)) out.segment = segment;
  const view = sp.get("view");
  if (isRevenueView(view)) out.view = view;
  const brands = sp.getAll("brand").map(brandKey).filter(Boolean);
  if (brands.length > 0 && brands.length <= MAX_BRAND_FILTERS && brands.every((k) => k.length <= MAX_BRAND_LENGTH)) out.brands = [...new Set(brands)];
  const items = (sp.get("items") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (items.length > 0 && items.length <= MAX_URL_ITEMS && items.every((id) => ITEM_ID_RE.test(id))) out.items = [...new Set(items)];
  return out;
}

/** The query string (with its `?`, or "" when every control is at its default) for the page's current state. */
export function controlsToSearch(c: {
  granularity: RevenueGranularity;
  taxMode: TaxMode;
  stack: StackDimension;
  range: RangeChoice;
  kind: RevenueKind | null;
  segment: CustomerSegment | null;
  view: RevenueView;
  brands: Iterable<string>;
  items: readonly string[];
}): string {
  const sp = new URLSearchParams();
  if (c.granularity !== "month") sp.set("g", c.granularity);
  if (c.taxMode !== "ht") sp.set("tax", c.taxMode);
  if (c.stack !== "nature") sp.set("stack", c.stack);
  if (c.range.preset === "custom") {
    sp.set("from", c.range.from);
    sp.set("to", c.range.to);
  } else if (c.range.preset !== "default") sp.set("preset", c.range.preset);
  if (c.kind) sp.set("kind", c.kind);
  if (c.segment) sp.set("segment", c.segment);
  if (c.view !== "evolution") sp.set("view", c.view);
  for (const b of c.brands) sp.append("brand", b);
  if (c.items.length > 0) sp.set("items", c.items.join(","));
  const q = sp.toString().replace(/%2C/g, ",");
  return q ? `?${q}` : "";
}
