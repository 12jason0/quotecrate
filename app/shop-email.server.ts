/**
 * Resolving the shop owner's email address.
 *
 * The merchant-facing "new quote request" notification has to reach whoever
 * runs the store, and the only address the app can know without asking is the
 * one Shopify already has on file for the shop owner.
 *
 * `Shop.email` is `String!` — "The shop owner's email address. Shopify will use
 * this email address to communicate with the shop owner."
 * https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Shop
 */

import { unauthenticated } from "./shopify.server";

const SHOP_EMAIL_QUERY = `#graphql
  query quoteCrateShopEmail {
    shop {
      email
    }
  }`;

type ShopEmailResponse = {
  data?: { shop?: { email?: string | null } | null } | null;
};

/**
 * Read the shop owner's email when there is no admin request to authenticate —
 * the storefront app proxy — by using the offline token stored at install.
 * Same shape, and same caveat, as the currency lookup: the docs warn that
 * `unauthenticated.admin` performs no validation, and the only caller passes a
 * shop domain taken from an app proxy request whose HMAC signature covers the
 * query string, so the value is already verified by the time it arrives here.
 *
 * Returns null rather than throwing: a shopper's quote request is already saved
 * by the time this runs, so a failed lookup must only cost the notification.
 */
export async function getShopEmail(shop: string): Promise<string | null> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    const response = await admin.graphql(SHOP_EMAIL_QUERY);
    const json = (await response.json()) as ShopEmailResponse;

    return json?.data?.shop?.email ?? null;
  } catch (error) {
    console.warn(
      `[quotecrate] Could not read the shop owner's email for ${shop}.`,
      error,
    );
    return null;
  }
}
