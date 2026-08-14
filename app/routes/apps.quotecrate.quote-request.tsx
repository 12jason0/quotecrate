import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { sendQuoteRequestNotification } from "../quote-notification.server";
import { checkQuoteRequestRate } from "../quote-rate-limit.server";
import { authenticate } from "../shopify.server";
import { FALLBACK_CURRENCY, shopCurrency } from "../shop-currency.server";

/**
 * Public app proxy endpoint for storefront quote requests.
 *
 * This route is reached by shoppers who are not logged into the admin, so it
 * must never use `authenticate.admin`. Trust comes entirely from
 * `authenticate.public.appProxy`, which validates the HMAC `signature` query
 * parameter Shopify appends, and throws a 400 Response when it does not match.
 */

// Storefront input is untrusted, so every field is length-capped before it
// reaches the database.
const LIMITS = {
  customerName: 200,
  customerEmail: 320,
  company: 200,
  note: 2000,
  title: 500,
  variantTitle: 500,
  gid: 200,
} as const;

const MAX_QUANTITY = 1_000_000;

/**
 * Matches the Liquid `for` loop ceiling in the storefront block (50 iterations),
 * so a request can never carry more rows than the form can render.
 */
const MAX_ITEMS = 50;

type IncomingItem = {
  title: string;
  quantity: number;
  productId: string | null;
  variantId: string | null;
  variantTitle: string | null;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function readString(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

/** Deliberately permissive: enough to catch typos, not to police addresses. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Normalise one submitted line into a QuoteItem, or null if it is not usable.
 *
 * Rows the shopper left blank arrive as quantity 0 or absent and are simply
 * dropped: the storefront renders every product in the collection, so most of
 * them being empty is the normal case, not an error.
 */
function readItem(raw: unknown): IncomingItem | null {
  if (typeof raw !== "object" || raw === null) return null;

  const input = raw as Record<string, unknown>;

  const title = readString(input.title, LIMITS.title);
  if (!title) return null;

  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return null;
  }

  const productId = readString(input.productId, LIMITS.gid);
  const variantId = readString(input.variantId, LIMITS.gid);
  const variantTitle = readString(input.variantTitle, LIMITS.variantTitle);

  return {
    title,
    quantity,
    productId: productId || null,
    variantId: variantId || null,
    variantTitle: variantTitle || null,
  };
}

/**
 * Accepts the current `items` array, and falls back to the flat single-product
 * fields the block used to send. The fallback exists because a shopper can have
 * an older cached copy of quote-request.js after an update, and their request
 * should still land rather than silently fail.
 */
function readItems(input: Record<string, unknown>): IncomingItem[] {
  const source = Array.isArray(input.items)
    ? input.items.slice(0, MAX_ITEMS)
    : [input];

  const items: IncomingItem[] = [];
  for (const entry of source) {
    const item = readItem(entry);
    if (item) items.push(item);
  }

  return items;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verify first so an unsigned probe learns nothing about this endpoint.
  await authenticate.public.appProxy(request);

  return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  // The signature covers the query string, so `shop` here is trustworthy.
  const shop =
    session?.shop ?? new URL(request.url).searchParams.get("shop") ?? "";

  if (!shop) {
    return jsonResponse({ ok: false, error: "Missing shop" }, 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  if (typeof body !== "object" || body === null) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const input = body as Record<string, unknown>;

  const customerName = readString(input.customerName, LIMITS.customerName);
  const customerEmail = readString(input.customerEmail, LIMITS.customerEmail);
  const company = readString(input.company, LIMITS.company);
  const note = readString(input.note, LIMITS.note);

  if (!customerName) {
    return jsonResponse({ ok: false, error: "Please enter your name." }, 400);
  }

  if (!looksLikeEmail(customerEmail)) {
    return jsonResponse(
      { ok: false, error: "Please enter a valid email address." },
      400,
    );
  }

  const items = readItems(input);

  if (items.length === 0) {
    return jsonResponse(
      {
        ok: false,
        error: "Enter a quantity for at least one product.",
      },
      400,
    );
  }

  // Checked after validation, so a malformed request is refused on its own
  // merits, and before the write, so a flood costs one COUNT rather than a row,
  // an Admin API call and an email.
  const rate = await checkQuoteRequestRate(shop, customerEmail);
  if (!rate.allowed) {
    return jsonResponse({ ok: false, error: rate.reason }, 429);
  }

  // Read from the ShopSetting cache the admin side keeps warm, so this is
  // normally a local read rather than a live Admin API call that can fail for
  // reasons the shopper never sees.
  //
  // FALLBACK_CURRENCY is reached only when this shop's currency has never once
  // been read. It is not a silent decision any more: the quote is created with
  // no prices on it, and `adoptShopCurrency` re-stamps it with the real
  // currency when the merchant opens it — before any amount can be typed
  // against the wrong one.
  const currency = (await shopCurrency(shop)) ?? FALLBACK_CURRENCY;

  const quote = await prisma.quote.create({
    data: {
      shop,
      customerName,
      customerEmail,
      company: company || null,
      note: note || null,
      status: "REQUESTED",
      currency,
      items: {
        create: items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          title: item.title,
          variantTitle: item.variantTitle,
          quantity: item.quantity,
          // Pricing is the merchant's job, in the admin dashboard.
          quotedUnitPriceMinor: null,
        })),
      },
    },
  });

  // Tell the merchant, but never at the shopper's expense: the quote is already
  // committed, so the response goes out immediately and the email is left to
  // finish on its own. `sendQuoteRequestNotification` swallows its own failures
  // (it logs and resolves false); the `catch` here is only a guard against an
  // unhandled rejection taking the server down.
  //
  // Deliberately not awaited. This app runs as a long-lived Node server
  // (react-router-serve), so the promise survives the response; on a serverless
  // host this would need the platform's "wait until" hook instead.
  void sendQuoteRequestNotification({
    shop,
    quoteId: quote.id,
    customerName,
    customerEmail,
    company: company || null,
    note: note || null,
    items: items.map((item) => ({
      title: item.title,
      variantTitle: item.variantTitle,
      quantity: item.quantity,
    })),
  }).catch(() => {});

  return jsonResponse({ ok: true, quoteId: quote.id }, 201);
};
