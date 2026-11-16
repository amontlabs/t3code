/**
 * The viewer's order for **Usage → Limits** and the Usage hover: providers, then accounts within each. Kept in
 * this browser (a per-viewer convenience); what isn't in it keeps the default order after what is.
 */
import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

const LimitOrderSchema = Schema.Struct({
  providers: Schema.Array(Schema.String),
  accounts: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type LimitOrder = typeof LimitOrderSchema.Type;

const STORAGE_KEY = "t3code:lastdrop:usage-limits-order:v1";
const NO_ORDER: LimitOrder = { providers: [], accounts: {} };

export function useLimitOrder() {
  return useLocalStorage(STORAGE_KEY, NO_ORDER, LimitOrderSchema);
}

/** `items` sorted by where `order` puts their id; unlisted ones keep their place after the listed ones. */
export function inOrder<T>(
  items: ReadonlyArray<T>,
  idOf: (item: T) => string,
  order: ReadonlyArray<string> | undefined,
): ReadonlyArray<T> {
  if (order === undefined || order.length === 0) return items;
  const rank = (item: T) => {
    const index = order.indexOf(idOf(item));
    return index < 0 ? order.length : index;
  };
  return items.toSorted((left, right) => rank(left) - rank(right));
}
