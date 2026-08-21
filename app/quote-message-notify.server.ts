/**
 * "New message" emails for the quote conversation.
 *
 * One message, one email, to whichever side did not write it: the merchant is
 * told when the buyer replies, the buyer is told when the merchant does. Neither
 * side is sitting on the page waiting, so a conversation with no notification is
 * a conversation that quietly dies.
 *
 * Sent with Resend, the same way the other two mails are
 * (quote-notification.server.ts, quote-ready.server.ts), so there is still one
 * mail provider to configure and one place its failures are logged.
 *
 * There is no duplicate guard here, on purpose. The guard belongs upstream, on
 * the write: appendMessage only reports "created" for a message that was really
 * stored, and only a created message is notified. Guarding in both places would
 * mean two windows that can disagree about what counts as the same message.
 */

import { Resend } from "resend";

import { escapeHtml, escapeMultiline } from "./escape-html";
import { adminQuoteUrl, resolveRecipient } from "./quote-notification.server";

/** Buyer-facing accent, matching the quote page and the "quote ready" email. */
const ACCENT = "#a4552b";

/** Merchant-facing accent, matching the "new quote request" email. */
const ADMIN_ACCENT = "#303030";

/**
 * Whether the other side was told.
 *
 * The merchant path reports `error` because a merchant is standing in front of
 * the screen when they press Send and has to know whether their customer heard
 * them. The buyer path never surfaces one — a buyer cannot act on "Resend
 * rejected the message" — so its failures end in the log.
 */
export type MessageNotifyResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * The one Resend call both directions share.
 *
 * Never throws: every failure comes back as `{ ok: false }` with a sentence a
 * merchant could read. The message is already stored by the time this runs and
 * is never rolled back on a failure — losing what someone wrote because their
 * counterpart's mail server was down would be the worse outcome by far.
 */
async function send({
  quoteId,
  to,
  subject,
  html,
  direction,
}: {
  quoteId: string;
  to: string;
  subject: string;
  html: string;
  direction: "customer" | "merchant";
}): Promise<MessageNotifyResult> {
  try {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const from = process.env.QUOTE_NOTIFY_FROM?.trim();

    if (!apiKey || !from) {
      console.warn(
        `[quotecrate] RESEND_API_KEY or QUOTE_NOTIFY_FROM is not set; could not tell the ${direction} about the new message on quote ${quoteId}.`,
      );
      return {
        ok: false,
        error:
          "Email sending isn't configured for this app yet, so nothing was sent.",
      };
    }

    const { data, error } = await new Resend(apiKey).emails.send({
      from,
      to,
      subject,
      html,
    });

    // Resend reports an API rejection in `error` rather than by throwing, so
    // this branch is the common failure, not the catch below.
    if (error) {
      console.error(
        `[quotecrate] Resend rejected the ${direction} message notification for quote ${quoteId}.`,
        error,
      );
      return {
        ok: false,
        error: error.message || "The email provider rejected the message.",
      };
    }

    console.log(
      `[quotecrate] Told the ${direction} about the new message on quote ${quoteId} (Resend id ${data?.id}).`,
    );
    return { ok: true };
  } catch (error) {
    console.error(
      `[quotecrate] Could not tell the ${direction} about the new message on quote ${quoteId}.`,
      error,
    );
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "The email could not be sent.",
    };
  }
}

/**
 * The quoted message itself, in both emails.
 *
 * `escapeMultiline`, not `escapeHtml`: an email client has no `pre-wrap` to fall
 * back on, so without the `<br />` conversion a reply written as three
 * paragraphs arrives as one run-on sentence.
 */
function quotedBody(body: string, accent: string): string {
  return `<blockquote style="margin:20px 0 0;padding:14px 18px;border-left:3px solid ${accent};background:#f7f7f7;border-radius:0 8px 8px 0;font-size:14px;color:#4a4a4a;">${escapeMultiline(
    body,
  )}</blockquote>`;
}

export type CustomerMessageEmail = {
  quoteId: string;
  /** The store as the buyer should see it named. */
  storeName: string;
  customerName: string;
  customerEmail: string;
  /** The buyer's own quote page — where the reply box is. */
  quoteUrl: string;
  body: string;
};

/**
 * Build the buyer's copy. Separate from the send so the wording and the escaping
 * can be read without the network call in the way, and so the preview renderer
 * and a test can produce the HTML without sending anything.
 */
export function buildCustomerMessageEmail(email: CustomerMessageEmail): {
  subject: string;
  html: string;
} {
  const { storeName, customerName, quoteUrl, body } = email;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="margin:0;padding:24px;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#303030;">
    <div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;border-radius:12px;">
      <h1 style="margin:0 0 16px;font-size:18px;">New message about your quote</h1>

      <p style="margin:0 0 16px;font-size:14px;">Hi ${escapeHtml(customerName)},</p>
      <p style="margin:0;font-size:14px;">
        ${escapeHtml(storeName)} replied about your quote.
      </p>

      ${quotedBody(body, ACCENT)}

      <p style="margin:24px 0 0;">
        <a href="${escapeHtml(quoteUrl)}" style="display:inline-block;padding:12px 20px;background:${ACCENT};color:#ffffff;border-radius:8px;text-decoration:none;font-weight:700;">Open your quote &amp; reply</a>
      </p>

      <p style="margin:16px 0 0;font-size:13px;color:#616161;">
        The whole conversation, and the prices, are on that page.
      </p>
    </div>
  </body>
</html>`;

  return {
    subject: `New message about your quote from ${storeName}`,
    html,
  };
}

/**
 * Tell the buyer the merchant wrote to them.
 *
 * The recipient is the quote's own `customerEmail`. QUOTE_NOTIFY_TO is a testing
 * override for the *merchant* notification and deliberately has no say here:
 * redirecting a buyer's mail to a developer's inbox would be a silent
 * misdelivery — the same rule quote-ready.server.ts follows.
 */
export async function notifyCustomerOfMessage(
  email: CustomerMessageEmail,
): Promise<MessageNotifyResult> {
  const { subject, html } = buildCustomerMessageEmail(email);

  return send({
    quoteId: email.quoteId,
    to: email.customerEmail,
    subject,
    html,
    direction: "customer",
  });
}

export type MerchantMessageEmail = {
  shop: string;
  quoteId: string;
  customerName: string;
  customerEmail: string;
  body: string;
};

export function buildMerchantMessageEmail(email: MerchantMessageEmail): {
  subject: string;
  html: string;
} {
  const { shop, quoteId, customerName, customerEmail, body } = email;

  const dashboardUrl = adminQuoteUrl(shop, quoteId);
  const callToAction = dashboardUrl
    ? `<p style="margin:24px 0 0;">
        <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:10px 16px;background:${ADMIN_ACCENT};color:#ffffff;border-radius:8px;text-decoration:none;">Open this quote &amp; reply</a>
      </p>`
    : `<p style="margin:24px 0 0;font-size:14px;">Open this quote in your dashboard to reply.</p>`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body style="margin:0;padding:24px;background:#f1f1f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#303030;">
    <div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;border-radius:12px;">
      <h1 style="margin:0 0 16px;font-size:18px;">New message on a quote</h1>

      <p style="margin:0;font-size:14px;">
        ${escapeHtml(customerName)} (<a href="mailto:${escapeHtml(
          customerEmail,
        )}" style="color:#005bd3;">${escapeHtml(
          customerEmail,
        )}</a>) wrote about quote #${escapeHtml(quoteId.slice(-6).toUpperCase())}.
      </p>

      ${quotedBody(body, ADMIN_ACCENT)}

      ${callToAction}
    </div>
  </body>
</html>`;

  return {
    subject: `New message on a quote from ${customerName}`,
    html,
  };
}

/**
 * Tell the merchant the buyer replied.
 *
 * Goes to the same address the "new quote request" notification does, so a
 * merchant who has already pointed that at the right inbox does not have to
 * configure a second one.
 *
 * Never throws: this is called from the buyer's page, where the reply is already
 * stored and the buyer must be shown their message either way.
 */
export async function notifyMerchantOfMessage(
  email: MerchantMessageEmail,
): Promise<MessageNotifyResult> {
  const to = await resolveRecipient(email.shop);

  if (!to) {
    console.warn(
      `[quotecrate] No recipient for the new message on quote ${email.quoteId}: QUOTE_NOTIFY_TO is unset and the shop owner's email could not be read.`,
    );
    return { ok: false, error: "No merchant address could be resolved." };
  }

  const { subject, html } = buildMerchantMessageEmail(email);

  return send({
    quoteId: email.quoteId,
    to,
    subject,
    html,
    direction: "merchant",
  });
}
