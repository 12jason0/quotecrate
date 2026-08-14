/**
 * Quote → Shopify draft order conversion.
 *
 * The whole point of a quote is the merchant-negotiated price, so the line
 * prices sent to Shopify must be the quoted ones, never the variant's catalog
 * price. Per the Admin GraphQL reference for `DraftOrderLineItemInput`:
 *
 *   - `priceOverride` (MoneyInput) — "The price override for the line item.
 *     Should be set in presentment currency." This is the field that replaces a
 *     variant's catalog price, and it is the one to use when `variantId` is set.
 *   - `originalUnitPriceWithCurrency` (MoneyInput) — "The price in presentment
 *     currency, without any discounts applied, for a custom line item." It is
 *     ignored when `variantId` is provided, so it only applies to custom lines.
 *   - `originalUnitPrice` (Money) is deprecated and is not used here.
 *   - `title` is likewise "ignored when `variantId` is provided".
 *
 * https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/DraftOrderLineItemInput
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

import { currencyDecimals, minorUnitFactor } from "./quotes";
import { getShopCurrency } from "./shop-currency.server";

const VARIANT_GID_PREFIX = "gid://shopify/ProductVariant/";

export type DraftOrderQuoteItem = {
  title: string;
  variantId: string | null;
  quantity: number;
  quotedUnitPriceMinor: number | null;
};

export type DraftOrderQuote = {
  id: string;
  customerName: string;
  customerEmail: string;
  company: string | null;
  currency: string;
  note: string | null;
  items: DraftOrderQuoteItem[];
};

export type ConvertResult =
  | {
      ok: true;
      draftOrderId: string;
      draftOrderName: string;
      invoiceUrl: string | null;
    }
  | { ok: false; errors: string[] };

export type InvoiceSendResult = { ok: true } | { ok: false; errors: string[] };

type MoneyInput = { amount: string; currencyCode: string };

type VariantLineItem = {
  variantId: string;
  quantity: number;
  priceOverride: MoneyInput;
};

type CustomLineItem = {
  title: string;
  quantity: number;
  originalUnitPriceWithCurrency: MoneyInput;
};

export type DraftOrderLineItem = VariantLineItem | CustomLineItem;

const DRAFT_ORDER_CREATE_MUTATION = `#graphql
  mutation quoteCrateDraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        invoiceUrl
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * Shopify sends this invoice email itself, so no external mail provider is
 * involved. Per the Admin GraphQL reference for `draftOrderInvoiceSend`:
 *
 *   - `id` (ID!) — "Specifies the draft order to send the invoice for."
 *   - `email` (EmailInput) — "Specifies the draft order invoice email fields."
 *     Optional; omitting it falls back to the draft order's own email. `to` is
 *     passed explicitly anyway so the recipient is the quote's contact and does
 *     not depend on that fallback.
 *
 * `EmailInput.to` is the recipient field ("Specifies the email recipient").
 *
 * https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/draftOrderInvoiceSend
 */
const DRAFT_ORDER_INVOICE_SEND_MUTATION = `#graphql
  mutation quoteCrateDraftOrderInvoiceSend($id: ID!, $email: EmailInput) {
    draftOrderInvoiceSend(id: $id, email: $email) {
      draftOrder {
        id
      }
      userErrors {
        field
        message
      }
    }
  }`;

type DraftOrderInvoiceSendResponse = {
  data?: {
    draftOrderInvoiceSend?: {
      draftOrder?: { id: string } | null;
      userErrors?: { field?: string[] | null; message: string }[] | null;
    } | null;
  } | null;
};

type DraftOrderCreateResponse = {
  data?: {
    draftOrderCreate?: {
      draftOrder?: {
        id: string;
        name: string;
        invoiceUrl: string | null;
      } | null;
      userErrors?: { field?: string[] | null; message: string }[] | null;
    } | null;
  } | null;
};

/**
 * Ask Shopify to email the draft order's invoice (the payment link) to the
 * customer.
 *
 * Deliberately never throws for a send failure: the draft order already exists
 * by this point, so the caller must be able to keep the quote CONVERTED and
 * merely report that the email did not go out.
 */
export async function sendDraftOrderInvoice(
  admin: AdminApiContext,
  draftOrderId: string,
  toEmail: string,
): Promise<InvoiceSendResult> {
  try {
    const response = await admin.graphql(DRAFT_ORDER_INVOICE_SEND_MUTATION, {
      variables: { id: draftOrderId, email: { to: toEmail } },
    });

    const json = (await response.json()) as DraftOrderInvoiceSendResponse;
    const payload = json?.data?.draftOrderInvoiceSend;

    const userErrors = payload?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, errors: userErrors.map((error) => error.message) };
    }

    if (!payload?.draftOrder) {
      return {
        ok: false,
        errors: ["Shopify did not confirm that the invoice email was sent."],
      };
    }

    return { ok: true };
  } catch (error) {
    // A thrown Response is the library asking for re-authentication; that has
    // to keep bubbling up to React Router.
    if (error instanceof Response) throw error;

    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/**
 * The storefront form supplies variant ids, so they are untrusted. Accept a
 * full variant GID or a bare numeric id; anything else falls back to a custom
 * line item rather than sending a malformed id to Shopify.
 */
export function toVariantGid(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.startsWith(VARIANT_GID_PREFIX)) {
    return trimmed.length > VARIANT_GID_PREFIX.length ? trimmed : null;
  }
  if (/^\d+$/.test(trimmed)) {
    return `${VARIANT_GID_PREFIX}${trimmed}`;
  }

  return null;
}

function money(minor: number, currencyCode: string): MoneyInput {
  // MoneyInput.amount is a Decimal, so it travels as a string to avoid the
  // float rounding that storing whole minor units exists to prevent.
  //
  // The precision is the currency's own, not a fixed 2. A three-decimal
  // currency sent as "12.35" instead of "12.345" would invoice the buyer a
  // different amount than the merchant quoted.
  const decimals = currencyDecimals(currencyCode);

  return {
    amount: (minor / minorUnitFactor(currencyCode)).toFixed(decimals),
    currencyCode,
  };
}

/**
 * Map quote lines onto DraftOrderLineItemInput, always at the quoted unit
 * price. Exported separately from the network call so the pricing rule can be
 * read (and tested) on its own.
 */
export function buildDraftOrderLineItems(
  items: DraftOrderQuoteItem[],
  currencyCode: string,
): DraftOrderLineItem[] {
  return items.map((item) => {
    const minor = item.quotedUnitPriceMinor ?? 0;
    const price = money(minor, currencyCode);
    const variantId = toVariantGid(item.variantId);

    if (variantId) {
      // priceOverride is what makes the draft order bill the quoted price
      // instead of the variant's catalog price.
      return { variantId, quantity: item.quantity, priceOverride: price };
    }

    // No usable variant: a custom line carries its own title and price.
    return {
      title: item.title,
      quantity: item.quantity,
      originalUnitPriceWithCurrency: price,
    };
  });
}

function buildNote(quote: DraftOrderQuote): string {
  const lines = [
    `QuoteCrate quote ${quote.id}`,
    `Customer: ${quote.customerName} <${quote.customerEmail}>`,
  ];
  if (quote.company) lines.push(`Company: ${quote.company}`);
  if (quote.note) lines.push("", quote.note);

  return lines.join("\n");
}

/**
 * Create a payable draft order for a quote. Returns the draft order id and
 * invoice URL, or the userErrors verbatim so the caller can show them and
 * leave the quote's status untouched.
 */
export async function convertQuoteToDraftOrder(
  admin: AdminApiContext,
  quote: DraftOrderQuote,
): Promise<ConvertResult> {
  if (quote.items.length === 0) {
    return { ok: false, errors: ["This quote has no line items."] };
  }

  const unpriced = quote.items.filter(
    (item) => item.quotedUnitPriceMinor === null,
  );
  if (unpriced.length > 0) {
    return {
      ok: false,
      errors: [
        `Every line item needs a unit price before this quote can be converted. Missing: ${unpriced
          .map((item) => item.title)
          .join(", ")}`,
      ],
    };
  }

  try {
    // priceOverride is interpreted in the draft order's presentment currency.
    // The draft order is created in the shop's currency, so a quote priced in
    // some other currency would be silently converted — refuse instead of
    // invoicing an amount the merchant never quoted. Quotes are now created in
    // the shop's own currency, so this is a backstop rather than a routine path.
    const shopCurrency = await getShopCurrency(admin);

    if (!shopCurrency) {
      return { ok: false, errors: ["Couldn't determine the store's currency."] };
    }
    if (shopCurrency !== quote.currency) {
      return {
        ok: false,
        errors: [
          `This quote is priced in ${quote.currency} but the store's currency is ${shopCurrency}, so the amounts would be converted rather than invoiced as quoted. Re-price this quote in ${shopCurrency} before converting it.`,
        ],
      };
    }

    const response = await admin.graphql(DRAFT_ORDER_CREATE_MUTATION, {
      variables: {
        input: {
          email: quote.customerEmail,
          note: buildNote(quote),
          tags: ["QuoteCrate"],
          lineItems: buildDraftOrderLineItems(quote.items, shopCurrency),
        },
      },
    });

    const json = (await response.json()) as DraftOrderCreateResponse;
    const payload = json?.data?.draftOrderCreate;

    const userErrors = payload?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, errors: userErrors.map((error) => error.message) };
    }

    const draftOrder = payload?.draftOrder;
    if (!draftOrder) {
      return {
        ok: false,
        errors: ["Shopify didn't return a draft order."],
      };
    }

    return {
      ok: true,
      draftOrderId: draftOrder.id,
      draftOrderName: draftOrder.name,
      invoiceUrl: draftOrder.invoiceUrl,
    };
  } catch (error) {
    // A thrown Response is the library asking for re-authentication; that has
    // to keep bubbling up to React Router.
    if (error instanceof Response) throw error;

    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
