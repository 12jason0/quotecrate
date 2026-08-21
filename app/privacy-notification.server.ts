/**
 * Delivering a `customers/data_request` to the merchant.
 *
 * Shopify's instruction for this webhook is that the app provides the data "to
 * the store owner directly" — Shopify does not collect it, and there is no API
 * to hand it back through.
 * https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 *
 * So it goes out the one channel this app already has to the merchant: the
 * Resend mail that carries quote notifications. The recipient is resolved the
 * same way, meaning QUOTE_NOTIFY_TO still redirects it while testing and the
 * shop owner's own address is used in production.
 *
 * Like every other send in this app, nothing here throws: a compliance webhook
 * must answer 200 or Shopify retries it, and the export is logged in full
 * whether or not the mail goes out, so the merchant's request can still be
 * answered by hand from the server logs.
 */

import { Resend } from "resend";

import { escapeHtml, escapeMultiline } from "./escape-html";
import type { CustomerQuoteExport } from "./privacy.server";
import { resolveRecipient } from "./quote-notification.server";

function quoteSection(quote: CustomerQuoteExport): string {
  const items = quote.items
    .map(
      (item) =>
        `<li>${escapeHtml(
          item.variantTitle ? `${item.title} — ${item.variantTitle}` : item.title,
        )} × ${item.quantity}</li>`,
    )
    .join("");

  const messages = quote.messages
    .map(
      (message) =>
        `<li><strong>${escapeHtml(message.author)}</strong> (${escapeHtml(
          message.createdAt,
        )}):<br />${escapeMultiline(message.body)}</li>`,
    )
    .join("");

  return `<h2 style="margin:24px 0 8px;font-size:14px;">Quote ${escapeHtml(quote.quoteId)}</h2>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 12px 4px 0;color:#616161;">Requested</td><td>${escapeHtml(quote.createdAt)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#616161;">Status</td><td>${escapeHtml(quote.status)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#616161;">Name</td><td>${escapeHtml(quote.customerName)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#616161;">Email</td><td>${escapeHtml(quote.customerEmail)}</td></tr>
      ${quote.company ? `<tr><td style="padding:4px 12px 4px 0;color:#616161;">Company</td><td>${escapeHtml(quote.company)}</td></tr>` : ""}
    </table>
    ${quote.note ? `<p style="margin:12px 0 0;font-size:14px;"><strong>Note:</strong><br />${escapeMultiline(quote.note)}</p>` : ""}
    ${items ? `<p style="margin:12px 0 4px;font-size:14px;"><strong>Items</strong></p><ul style="margin:0;font-size:14px;">${items}</ul>` : ""}
    ${messages ? `<p style="margin:12px 0 4px;font-size:14px;"><strong>Messages</strong></p><ul style="margin:0;font-size:14px;">${messages}</ul>` : ""}`;
}

export function buildCustomerDataRequestEmail(
  customerEmail: string,
  quotes: CustomerQuoteExport[],
): { subject: string; html: string } {
  const body = quotes.length
    ? quotes.map(quoteSection).join("")
    : `<p style="margin:16px 0 0;font-size:14px;">QuoteCrate holds no data for this customer.</p>`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="margin:0;padding:24px;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#303030;">
    <div style="max-width:640px;margin:0 auto;padding:24px;background:#ffffff;border-radius:12px;">
      <h1 style="margin:0 0 8px;font-size:18px;">Customer data request</h1>
      <p style="margin:0;font-size:14px;">
        Shopify passed on a data request for
        <strong>${escapeHtml(customerEmail)}</strong>. Below is everything
        QuoteCrate stores about them for your shop. Forward it to the customer to
        complete the request.
      </p>
      ${body}
    </div>
  </body>
</html>`;

  return {
    subject: `Customer data request — ${customerEmail}`,
    html,
  };
}

export async function sendCustomerDataRequest(
  shop: string,
  customerEmail: string,
  quotes: CustomerQuoteExport[],
): Promise<boolean> {
  try {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.QUOTE_NOTIFY_FROM?.trim();

    if (!apiKey || !from) {
      console.warn(
        `[quotecrate] RESEND_API_KEY or QUOTE_NOTIFY_FROM is not set; the data request for ${customerEmail} at ${shop} was logged but not emailed.`,
      );
      return false;
    }

    const to = await resolveRecipient(shop);
    if (!to) {
      console.warn(
        `[quotecrate] No recipient for the data request for ${customerEmail} at ${shop}.`,
      );
      return false;
    }

    const { subject, html } = buildCustomerDataRequestEmail(
      customerEmail,
      quotes,
    );
    const { data, error } = await new Resend(apiKey).emails.send({
      from,
      to,
      subject,
      html,
    });

    if (error) {
      console.error(
        `[quotecrate] Resend rejected the data request email for ${shop}.`,
        error,
      );
      return false;
    }

    console.log(
      `[quotecrate] Sent the data request export for ${shop} (Resend id ${data?.id}).`,
    );
    return true;
  } catch (error) {
    console.error(
      `[quotecrate] Could not send the data request export for ${shop}.`,
      error,
    );
    return false;
  }
}
