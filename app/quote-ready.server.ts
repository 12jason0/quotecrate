/**
 * "Your quote is ready" email to the customer.
 *
 * Sent when the merchant prices a quote and presses Send on the quote detail
 * page. Until this existed, sending a quote only minted the public link and the
 * customer was told nothing — the merchant had to copy the link out and mail it
 * themselves, while the UI claimed the quote had been sent.
 *
 * Sent with Resend, the same way the merchant notification is
 * (quote-notification.server.ts), so there is one mail provider to configure.
 *
 * The one deliberate difference from that module: this one reports *why* it
 * failed instead of collapsing to a boolean. The merchant is standing in front
 * of the screen waiting to hear whether their customer was told, so "it didn't
 * go, here is what Resend said" has to survive back to the banner.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { Resend } from "resend";

import prisma from "./db.server";
import { escapeHtml } from "./escape-html";
import { formatMoney, storeName } from "./quotes";
import { shopName } from "./shop-name.server";

export type QuoteReadyItem = {
  title: string;
  variantTitle: string | null;
  quantity: number;
  /** Minor units of the quote's own currency, as stored. */
  unitPriceMinor: number;
};

export type QuoteReadyEmail = {
  quoteId: string;
  /** The store as the buyer should see it named. */
  storeName: string;
  customerName: string;
  customerEmail: string;
  currency: string;
  totalMinor: number;
  /** The buyer's own quote page — where "View & accept" goes. */
  quoteUrl: string;
  items: QuoteReadyItem[];
};

/**
 * Whether the customer was actually emailed.
 *
 * `error` is written for a merchant to read, not for a log: it ends up in a
 * banner on the quote detail page.
 */
export type QuoteReadySendResult =
  | { ok: true }
  | { ok: false; error: string };

/** Buyer-facing accent, matching the quote page the button opens. */
const ACCENT = "#a4552b";

function itemRow(item: QuoteReadyItem, currency: string): string {
  const name = item.variantTitle
    ? `${item.title} — ${item.variantTitle}`
    : item.title;

  const lineTotal = item.unitPriceMinor * item.quantity;

  return `<tr>
      <td style="padding:8px 12px 8px 0;border-bottom:1px solid #e3e3e3;">${escapeHtml(name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e3e3e3;text-align:right;white-space:nowrap;color:#616161;">× ${item.quantity}</td>
      <td style="padding:8px 0;border-bottom:1px solid #e3e3e3;text-align:right;white-space:nowrap;">${escapeHtml(
        formatMoney(lineTotal, currency),
      )}</td>
    </tr>`;
}

/**
 * Build the customer email. Kept separate from the sending so the wording and
 * the escaping can be read without the network call in the way, and so a test
 * can assert on the HTML without sending anything.
 *
 * Every value interpolated here originates as storefront input the customer
 * typed, or as money this app computed, so all of it is escaped.
 */
export function buildQuoteReadyEmail(email: QuoteReadyEmail): {
  subject: string;
  html: string;
} {
  const { storeName, customerName, currency, totalMinor, quoteUrl, items } =
    email;

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#303030;">
    <div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;border-radius:12px;">
      <h1 style="margin:0 0 16px;font-size:18px;">Your quote is ready</h1>

      <p style="margin:0 0 16px;font-size:14px;">Hi ${escapeHtml(customerName)},</p>
      <p style="margin:0 0 20px;font-size:14px;">
        ${escapeHtml(storeName)} has priced the quote you requested. Here is what
        it covers.
      </p>

      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        ${items.map((item) => itemRow(item, currency)).join("")}
        <tr>
          <td style="padding:12px 12px 0 0;font-weight:700;">Total</td>
          <td style="padding:12px 12px 0;"></td>
          <td style="padding:12px 0 0;text-align:right;font-weight:700;white-space:nowrap;">${escapeHtml(
            formatMoney(totalMinor, currency),
          )}</td>
        </tr>
      </table>

      <p style="margin:8px 0 0;font-size:13px;color:#616161;">
        Taxes and shipping are calculated at checkout.
      </p>

      <p style="margin:24px 0 0;">
        <a href="${escapeHtml(quoteUrl)}" style="display:inline-block;padding:12px 20px;background:${ACCENT};color:#ffffff;border-radius:8px;text-decoration:none;font-weight:700;">View &amp; accept your quote</a>
      </p>

      <p style="margin:16px 0 0;font-size:13px;color:#616161;">
        Accepting takes you straight to secure checkout at the prices above.
        Nothing is charged until you do.
      </p>
    </div>
  </body>
</html>`;

  return {
    subject: `Your quote from ${storeName} is ready`,
    html,
  };
}

/**
 * Email the customer that their quote is ready.
 *
 * Never throws: every failure comes back as `{ ok: false }` with a sentence the
 * merchant can act on. The prices are already saved by the time this runs, so a
 * failed send must never undo them — it only changes what the merchant is told.
 *
 * Note the recipient is the quote's own `customerEmail`. QUOTE_NOTIFY_TO is a
 * testing override for the *merchant* notification and deliberately has no say
 * here: redirecting a customer's quote to a developer's inbox would be a silent
 * misdelivery.
 */
export async function sendQuoteReadyEmail(
  email: QuoteReadyEmail,
): Promise<QuoteReadySendResult> {
  const { quoteId, customerEmail } = email;

  try {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.QUOTE_NOTIFY_FROM?.trim();

    if (!apiKey || !from) {
      console.warn(
        `[quotecrate] RESEND_API_KEY or QUOTE_NOTIFY_FROM is not set; could not email the customer about quote ${quoteId}.`,
      );
      return {
        ok: false,
        error:
          "Email sending isn't configured for this app yet, so nothing was sent.",
      };
    }

    const { subject, html } = buildQuoteReadyEmail(email);
    const { data, error } = await new Resend(apiKey).emails.send({
      from,
      to: customerEmail,
      subject,
      html,
    });

    // Resend reports an API rejection in `error` rather than by throwing, so
    // this branch is the common failure, not the catch below.
    if (error) {
      console.error(
        `[quotecrate] Resend rejected the customer email for quote ${quoteId}.`,
        error,
      );
      return {
        ok: false,
        error: error.message || "The email provider rejected the message.",
      };
    }

    console.log(
      `[quotecrate] Emailed the customer about quote ${quoteId} (Resend id ${data?.id}).`,
    );
    return { ok: true };
  } catch (error) {
    console.error(
      `[quotecrate] Could not email the customer about quote ${quoteId}.`,
      error,
    );
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The email could not be sent.",
    };
  }
}

/**
 * How long after the customer has been emailed a second send counts as a
 * duplicate rather than a fresh one.
 *
 * Long enough to swallow a double click or two admin tabs submitting together,
 * short enough that a merchant who genuinely re-prices a quote a minute later
 * can still tell the customer about it. A failed send releases the claim
 * immediately, so this never blocks a retry.
 */
export const QUOTE_EMAIL_COOLDOWN_MS = 60 * 1000;

/**
 * What happened to the customer's "your quote is ready" email, in the shape the
 * page reads back off the action.
 *
 * "skipped" is not a failure: it means this quote was emailed moments ago and
 * the duplicate was suppressed.
 */
export type CustomerEmailOutcome =
  | { quoteEmail: "sent"; quoteEmailTo: string }
  | { quoteEmail: "skipped"; quoteEmailTo: string }
  | { quoteEmail: "failed"; quoteEmailTo: string; quoteEmailError: string };

/**
 * Tell the customer their quote is ready, once.
 *
 * The prices are already committed by the time this runs and are never rolled
 * back on a failure: a saved quote the customer wasn't told about is fixable
 * from this page, whereas discarding the merchant's pricing is not. So the only
 * thing a failure changes is what the merchant is told — which is the point of
 * the whole change: the page must not claim a send that did not happen.
 */
export async function emailQuoteToCustomer({
  shop,
  admin,
  quote,
  unitPriceMinorById,
  totalMinor,
  quoteUrl,
}: {
  shop: string;
  /**
   * The merchant's own admin context, when the caller has one. Only used to name
   * the store; passing it keeps that lookup on the authenticated session rather
   * than on the shop's offline token.
   */
  admin?: AdminApiContext;
  quote: {
    id: string;
    customerName: string;
    customerEmail: string;
    currency: string;
    items: { id: string; title: string; variantTitle: string | null; quantity: number }[];
  };
  unitPriceMinorById: Map<string, number>;
  totalMinor: number;
  quoteUrl: string;
}): Promise<CustomerEmailOutcome> {
  const quoteEmailTo = quote.customerEmail;

  // Claim the send before handing anything to Resend. Two clicks racing each
  // other, or two admin tabs, would otherwise both deliver — the same
  // compare-and-set the conversion paths use to stop a double draft order.
  const claimedAt = new Date();
  const claimed = await prisma.quote.updateMany({
    where: {
      id: quote.id,
      shop,
      OR: [
        { quoteEmailSentAt: null },
        {
          quoteEmailSentAt: {
            lt: new Date(claimedAt.getTime() - QUOTE_EMAIL_COOLDOWN_MS),
          },
        },
      ],
    },
    data: { quoteEmailSentAt: claimedAt },
  });

  if (claimed.count === 0) {
    return { quoteEmail: "skipped", quoteEmailTo };
  }

  // The name the merchant trades under, cached, falling back to the shop handle
  // when it has never been read. Same resolution the buyer's quote page uses, so
  // the email and the page it links to introduce the same store.
  const store = storeName(shop, await shopName(shop, { admin }));

  const result = await sendQuoteReadyEmail({
    quoteId: quote.id,
    storeName: store,
    customerName: quote.customerName,
    customerEmail: quoteEmailTo,
    currency: quote.currency,
    totalMinor,
    quoteUrl,
    // Same order the buyer's own quote page lists them in, so the email and the
    // page it links to cannot disagree about which line is which.
    items: [...quote.items]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((item) => ({
        title: item.title,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        unitPriceMinor: unitPriceMinorById.get(item.id) ?? 0,
      })),
  });

  if (!result.ok) {
    // Release the claim: the cooldown exists to stop duplicates, not to make
    // the merchant wait a minute before retrying a send that never happened.
    await prisma.quote.updateMany({
      where: { id: quote.id, shop, quoteEmailSentAt: claimedAt },
      data: { quoteEmailSentAt: null },
    });

    return { quoteEmail: "failed", quoteEmailTo, quoteEmailError: result.error };
  }

  return { quoteEmail: "sent", quoteEmailTo };
}
