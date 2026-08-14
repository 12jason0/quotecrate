/**
 * Tokens for the buyer-facing quote link.
 *
 * The storefront quote page has no login: possession of the token is the only
 * thing that authorises reading and accepting a quote. So the token must come
 * from a CSPRNG and be long enough that guessing is hopeless — a sequential id
 * or a timestamp-derived value would let anyone walk other buyers' quotes.
 *
 * `randomBytes` is Node's CSPRNG. 24 bytes is 192 bits of entropy, rendered as
 * 32 URL-safe characters by base64url so it survives being pasted into a query
 * string without escaping.
 */

import { randomBytes } from "node:crypto";

const TOKEN_BYTES = 24;

export function newPublicToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * The storefront URL a buyer opens to review their quote.
 *
 * The path mirrors the app proxy configured in shopify.app.toml
 * (prefix "apps" + subpath "quotecrate"), so it maps onto the
 * app/routes/apps.quotecrate.quote.tsx route.
 */
export function customerQuoteUrl(shop: string, publicToken: string): string {
  return `https://${shop}/apps/quotecrate/quote?token=${encodeURIComponent(
    publicToken,
  )}`;
}
