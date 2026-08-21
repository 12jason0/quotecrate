/**
 * "New quote request" email to the merchant.
 *
 * Sent with Resend. Per https://resend.com/docs/send-with-nodejs the SDK is
 * `new Resend(apiKey)` plus `resend.emails.send({ from, to, subject, html })`,
 * which resolves to `{ data, error }` — an API rejection comes back in `error`
 * rather than as a thrown exception, so both have to be handled.
 *
 * Nothing here may break a shopper's submission. By the time this runs the
 * quote is already committed, so every failure path ends in a server-side log
 * and a `false` return; the caller does not wait for the result.
 */

import { Resend } from "resend";

import { escapeHtml, escapeMultiline } from "./escape-html";
import { getShopEmail } from "./shop-email.server";

export type QuoteNotificationItem = {
  title: string;
  variantTitle: string | null;
  quantity: number;
};

export type QuoteNotification = {
  shop: string;
  quoteId: string;
  customerName: string;
  customerEmail: string;
  company: string | null;
  note: string | null;
  items: QuoteNotificationItem[];
};

/**
 * Deep link to this quote's detail page in the Shopify admin.
 *
 * App Home lives at `https://admin.shopify.com/store/{store}/apps/{handle}`,
 * where the handle is "The URL slug of your App Home"
 * (https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration).
 * shopify.app.toml does not set `handle` — it is optional — so this falls back
 * to the client id, which the admin also resolves to the same app. Set
 * SHOPIFY_APP_HANDLE (and/or pin `handle` in shopify.app.toml) to make the link
 * independent of that fallback.
 *
 * The path after the handle is the app's own route, so `/app/quotes/{id}` maps
 * onto app/routes/app.quotes.$id.tsx.
 */
export function adminQuoteUrl(shop: string, quoteId: string): string | null {
  const storeHandle = shop.replace(/\.myshopify\.com$/, "");
  const appHandle =
    process.env.SHOPIFY_APP_HANDLE?.trim() ||
    process.env.SHOPIFY_API_KEY?.trim();

  if (!storeHandle || !appHandle) return null;

  return `https://admin.shopify.com/store/${storeHandle}/apps/${appHandle}/app/quotes/${quoteId}`;
}

function itemRow(item: QuoteNotificationItem): string {
  const name = item.variantTitle
    ? `${item.title} — ${item.variantTitle}`
    : item.title;

  return `<tr>
      <td style="padding:6px 12px 6px 0;border-bottom:1px solid #e3e3e3;">${escapeHtml(name)}</td>
      <td style="padding:6px 0;border-bottom:1px solid #e3e3e3;text-align:right;white-space:nowrap;">× ${item.quantity}</td>
    </tr>`;
}

function detailRow(label: string, value: string): string {
  return `<tr>
      <td style="padding:4px 12px 4px 0;color:#616161;white-space:nowrap;">${label}</td>
      <td style="padding:4px 0;">${value}</td>
    </tr>`;
}

/**
 * Build the merchant email. Kept separate from the sending so the wording and
 * the escaping can be read without the network call in the way.
 */
export function buildQuoteRequestEmail(notification: QuoteNotification): {
  subject: string;
  html: string;
} {
  const { customerName, customerEmail, company, note, items } = notification;

  const details = [
    detailRow("Name", escapeHtml(customerName)),
    ...(company ? [detailRow("Company", escapeHtml(company))] : []),
    detailRow(
      "Email",
      `<a href="mailto:${escapeHtml(customerEmail)}" style="color:#005bd3;">${escapeHtml(customerEmail)}</a>`,
    ),
  ].join("");

  const dashboardUrl = adminQuoteUrl(notification.shop, notification.quoteId);
  const callToAction = dashboardUrl
    ? `<p style="margin:24px 0 0;">Open your dashboard to price and send the quote.</p>
      <p style="margin:12px 0 0;">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:10px 16px;background:#303030;color:#ffffff;border-radius:8px;text-decoration:none;">View this quote request</a>
      </p>`
    : `<p style="margin:24px 0 0;">Open your dashboard to price and send the quote.</p>`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="margin:0;padding:24px;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#303030;">
    <div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;border-radius:12px;">
      <h1 style="margin:0 0 16px;font-size:18px;">New quote request</h1>

      <table style="border-collapse:collapse;font-size:14px;">${details}</table>

      <h2 style="margin:24px 0 8px;font-size:14px;">Items</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        ${items.map(itemRow).join("")}
      </table>
      ${
        note
          ? `<h2 style="margin:24px 0 8px;font-size:14px;">Note</h2>
      <p style="margin:0;font-size:14px;white-space:pre-wrap;">${escapeMultiline(note)}</p>`
          : ""
      }
      ${callToAction}
    </div>
  </body>
</html>`;

  return {
    subject: `New quote request from ${customerName}`,
    html,
  };
}

/**
 * Who the notification goes to.
 *
 * QUOTE_NOTIFY_TO wins when it is set, because a Resend account without a
 * verified domain can only deliver to the address it was signed up with — that
 * is the testing path. Leaving it unset is the production behaviour: the mail
 * goes to the shop owner's own address.
 */
export async function resolveRecipient(shop: string): Promise<string | null> {
  const override = process.env.QUOTE_NOTIFY_TO?.trim();
  if (override) return override;

  return getShopEmail(shop);
}

/**
 * Email the merchant about a new quote request.
 *
 * Never throws and never rejects: it resolves to whether the mail went out, so
 * a caller can ignore the result entirely.
 */
export async function sendQuoteRequestNotification(
  notification: QuoteNotification,
): Promise<boolean> {
  const { quoteId, shop } = notification;

  try {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.QUOTE_NOTIFY_FROM?.trim();

    if (!apiKey || !from) {
      console.warn(
        `[quotecrate] RESEND_API_KEY or QUOTE_NOTIFY_FROM is not set; skipping the notification for quote ${quoteId}.`,
      );
      return false;
    }

    const to = await resolveRecipient(shop);
    if (!to) {
      console.warn(
        `[quotecrate] No recipient for the quote ${quoteId} notification: QUOTE_NOTIFY_TO is unset and the shop owner's email could not be read.`,
      );
      return false;
    }

    const { subject, html } = buildQuoteRequestEmail(notification);
    const { data, error } = await new Resend(apiKey).emails.send({
      from,
      to,
      subject,
      html,
    });

    if (error) {
      console.error(
        `[quotecrate] Resend rejected the notification for quote ${quoteId}.`,
        error,
      );
      return false;
    }

    console.log(
      `[quotecrate] Sent the notification for quote ${quoteId} (Resend id ${data?.id}).`,
    );
    return true;
  } catch (error) {
    console.error(
      `[quotecrate] Could not send the notification for quote ${quoteId}.`,
      error,
    );
    return false;
  }
}
