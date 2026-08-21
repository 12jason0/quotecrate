/**
 * What the three mandatory compliance webhooks actually do to our data.
 *
 * Shopify requires every public app to answer `customers/data_request`,
 * `customers/redact` and `shop/redact`, and the answer has to be an action on
 * the app's own storage — a 200 with nothing behind it is the failure mode the
 * requirement exists to catch.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * The webhook routes are kept thin on purpose: they verify the request and hand
 * over to the functions here, so what the app stores about a person lives in one
 * file that can be read against the schema.
 *
 * The personal data this app holds is all on the quote:
 *   Quote.customerName, .customerEmail, .company, .note  — typed by the buyer
 *   QuoteMessage.body                                    — both sides of the thread
 * QuoteItem holds catalogue data only, and ShopSetting/Session are shop-level
 * facts with nothing personal in them beyond the shop owner's own store.
 */

import prisma from "./db.server";

/**
 * The buyer's address as Shopify sends it, matched against what the storefront
 * form recorded.
 *
 * The quote-request endpoint stores `customerEmail` exactly as the buyer typed
 * it (see app/routes/apps.quotecrate.quote-request.tsx), so "Buyer@Example.com"
 * and "buyer@example.com" can both be sitting in the table for one person.
 * Matching case-insensitively is what makes a redaction actually cover them —
 * Postgres supports it directly, which is why `mode` is safe to pass here.
 */
function customerEmailFilter(shop: string, email: string) {
  return {
    shop,
    customerEmail: { equals: email, mode: "insensitive" as const },
  };
}

export type CustomerQuoteExport = {
  quoteId: string;
  status: string;
  createdAt: string;
  customerName: string;
  customerEmail: string;
  company: string | null;
  note: string | null;
  items: {
    title: string;
    variantTitle: string | null;
    quantity: number;
  }[];
  messages: {
    author: string;
    body: string;
    createdAt: string;
  }[];
};

/**
 * Everything the app holds about one buyer at one shop.
 *
 * Returned rather than emailed from here so the webhook route decides how it
 * reaches the merchant, and so the shape can be logged when mail is not
 * configured.
 */
export async function collectCustomerData(
  shop: string,
  email: string,
): Promise<CustomerQuoteExport[]> {
  const quotes = await prisma.quote.findMany({
    where: customerEmailFilter(shop, email),
    orderBy: { createdAt: "asc" },
    include: {
      items: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  return quotes.map((quote) => ({
    quoteId: quote.id,
    status: quote.status,
    createdAt: quote.createdAt.toISOString(),
    customerName: quote.customerName,
    customerEmail: quote.customerEmail,
    company: quote.company,
    note: quote.note,
    items: quote.items.map((item) => ({
      title: item.title,
      variantTitle: item.variantTitle,
      quantity: item.quantity,
    })),
    messages: quote.messages.map((message) => ({
      author: message.author,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    })),
  }));
}

/**
 * Redact one buyer at one shop.
 *
 * The quote row survives with its personal fields overwritten rather than being
 * deleted outright. A quote is the merchant's record of a negotiation — several
 * of them carry a Shopify draft order the merchant has to be able to account
 * for — so removing the row would delete the merchant's own books to satisfy a
 * request about the buyer. This is the same shape Shopify applies to orders,
 * which are redacted in place, not erased.
 *
 * What does get deleted outright:
 *   - the whole message thread. Free text written by either side can name the
 *     buyer anywhere in it, and no scrub of a sentence is reliable; a thread
 *     with one participant removed is not a conversation anyway.
 *   - `publicToken`, the unguessable link that opens the buyer's quote page.
 *     Left in place it would keep serving the (now redacted) quote to anyone
 *     holding the URL.
 *
 * The replacement address uses the reserved `.invalid` TLD (RFC 2606) so a
 * redacted row can never be mailed by accident, and stays unique per quote so
 * nothing collapses two buyers into one.
 */
export async function redactCustomerData(
  shop: string,
  email: string,
): Promise<{ quotes: number; messages: number }> {
  const quotes = await prisma.quote.findMany({
    where: customerEmailFilter(shop, email),
    select: { id: true },
  });

  if (quotes.length === 0) return { quotes: 0, messages: 0 };

  const quoteIds = quotes.map((quote) => quote.id);

  const [messages] = await prisma.$transaction([
    prisma.quoteMessage.deleteMany({ where: { quoteId: { in: quoteIds } } }),
    ...quoteIds.map((id) =>
      prisma.quote.update({
        where: { id },
        data: {
          customerName: "Redacted",
          customerEmail: `redacted+${id}@redacted.invalid`,
          company: null,
          note: null,
          publicToken: null,
        },
      }),
    ),
  ]);

  return { quotes: quoteIds.length, messages: messages.count };
}

/**
 * Erase a shop.
 *
 * Sent 48 hours after the app is uninstalled, and unlike the customer case
 * there is no merchant left whose records need preserving — so this is a
 * delete, not a redaction. Quote is the parent of QuoteItem and QuoteMessage
 * with `onDelete: Cascade`, so removing the quotes takes the thread and the
 * line items with them.
 *
 * `app/uninstalled` has normally already cleared the sessions by the time this
 * arrives; deleting them again is a no-op that costs nothing and covers the
 * case where that webhook never landed.
 */
export async function redactShopData(shop: string): Promise<{
  quotes: number;
  sessions: number;
  settings: number;
}> {
  const [quotes, sessions, settings] = await prisma.$transaction([
    prisma.quote.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
    prisma.shopSetting.deleteMany({ where: { shop } }),
  ]);

  return {
    quotes: quotes.count,
    sessions: sessions.count,
    settings: settings.count,
  };
}
