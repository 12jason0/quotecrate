/**
 * Getting a quote out of a half-finished conversion.
 *
 * Both the buyer's "Accept" and the merchant's "Convert to order" claim the
 * quote first — a compare-and-set from QUOTED to ACCEPTED — and only then ask
 * Shopify to create the draft order. That ordering is what stops two clicks
 * from billing the customer twice, and it must not change.
 *
 * Its cost is a window: if the process dies, or the request is abandoned,
 * between the claim and either the rollback or the CONVERTED write, the quote
 * is left ACCEPTED with no draftOrderId. Nothing moves it after that. The buyer
 * is told the store is finalising their order, the merchant's Convert button is
 * gone because the quote is no longer QUOTED, and the only way out is a hand
 * edit of the database.
 *
 * So "ACCEPTED with no draft order, and untouched for a while" is treated as
 * what it is — an attempt that never finished — and released back to QUOTED,
 * where both paths work again. Releasing rather than resuming keeps every
 * existing guard intact: the retry is an ordinary claim from QUOTED, not a
 * second write path into the conversion.
 */

import prisma from "./db.server";

/**
 * How long an ACCEPTED quote with no draft order is given before it counts as
 * abandoned.
 *
 * This is a safety margin, not a latency budget. A conversion in flight holds
 * the claim, and if it is released while it is still running, the quote can be
 * claimed again and the customer can end up with two draft orders — exactly
 * what the claim exists to prevent. Ten minutes is far beyond any HTTP request
 * that is still alive (the Admin API call itself times out in well under a
 * minute), so anything older has certainly died.
 */
export const STUCK_ACCEPTED_AFTER_MS = 10 * 60 * 1000;

type RecoverableQuote = {
  id: string;
  shop: string;
  status: string;
  draftOrderId: string | null;
  updatedAt: Date;
};

/** Is this row an accept that never produced an order? */
export function isStuckAccepted(quote: RecoverableQuote, now = Date.now()) {
  return (
    quote.status === "ACCEPTED" &&
    quote.draftOrderId === null &&
    now - quote.updatedAt.getTime() >= STUCK_ACCEPTED_AFTER_MS
  );
}

/**
 * Release a stuck ACCEPTED quote back to QUOTED, and return the quote as it now
 * stands. A quote that is not stuck is returned untouched, so this is safe to
 * call on the read path of any page that renders a quote.
 *
 * The update repeats the whole condition, including the age, so two readers
 * arriving together cannot both release it: the first bumps `updatedAt`, and
 * the second no longer matches.
 */
export async function reviveStuckAccepted<T extends RecoverableQuote>(
  quote: T,
): Promise<T> {
  const now = Date.now();
  if (!isStuckAccepted(quote, now)) return quote;

  const released = await prisma.quote.updateMany({
    where: {
      id: quote.id,
      shop: quote.shop,
      status: "ACCEPTED",
      draftOrderId: null,
      updatedAt: { lt: new Date(now - STUCK_ACCEPTED_AFTER_MS) },
    },
    data: { status: "QUOTED" },
  });

  if (released.count === 0) return quote;

  console.warn(
    `[quotecrate] Quote ${quote.id} was ACCEPTED with no draft order since ${quote.updatedAt.toISOString()}; released back to QUOTED so it can be converted again.`,
  );

  return { ...quote, status: "QUOTED" };
}
