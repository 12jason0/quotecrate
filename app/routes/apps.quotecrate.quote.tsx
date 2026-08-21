/**
 * Public app proxy page: the buyer's own view of a quote.
 *
 * Reached by a shopper who is not logged into the admin and, in general, not
 * logged into anything at all — so `authenticate.admin` must never appear here.
 * Two independent things establish trust:
 *
 *   1. `authenticate.public.appProxy` validates the HMAC `signature` Shopify
 *      appends to every proxied request, and throws a 400 Response when it does
 *      not match. That proves the request really came through this shop's
 *      storefront, and makes the `shop` on the request trustworthy.
 *   2. The `token` identifies exactly one quote. It is a 192-bit CSPRNG value
 *      (see public-token.server.ts), so it cannot be guessed, and the lookup is
 *      scoped to the verified shop as well.
 *
 * Responses are plain HTML rather than Polaris: this renders on the storefront,
 * outside the admin, where no Polaris runtime exists.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { notifyMerchantOfMessage } from "../quote-message-notify.server";
import { reviveStuckAccepted } from "../quote-recovery.server";
import {
  MESSAGE_MAX_LENGTH,
  appendMessage,
  buildThread,
  readMessageBody,
} from "../quote-thread.server";
import { shopProfile } from "../shop-profile.server";
import { authenticate } from "../shopify.server";
import {
  convertQuoteToDraftOrder,
  sendDraftOrderInvoice,
} from "../draft-order.server";
import {
  minorToNumber,
  formatDate,
  formatDateTime,
  formatMoney,
  storeName,
} from "../quotes";

const TOKEN_MAX_LENGTH = 200;

type QuoteWithItems = NonNullable<
  Awaited<ReturnType<typeof findQuoteByToken>>
>;

/**
 * Token + shop together, never token alone: the signature already proves which
 * shop is asking, so a token can only ever open a quote belonging to that shop.
 */
async function findQuoteByToken(shop: string, token: string) {
  return prisma.quote.findFirst({
    where: { shop, publicToken: token },
    include: {
      items: { orderBy: { title: "asc" } },
      // Read with the quote rather than separately: every page this route
      // renders shows the conversation, so there is no branch that would pay
      // for a query it does not use.
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Every colour and radius the page uses is declared once here, so a merchant
 * colour setting can later be implemented by overriding these few custom
 * properties rather than by editing markup. The defaults are the "warm" theme:
 * cream page, dark-brown header, terracotta accent.
 */
const THEME = `
  :root {
    --qc-page-bg: #fffdf9;
    --qc-surface: #ffffff;
    --qc-header-bg: #3b2416;
    --qc-header-text: #ffffff;
    --qc-accent: #a4552b;
    --qc-accent-strong: #8b4522;
    --qc-text: #3b2416;
    --qc-muted: #786651;
    --qc-muted-strong: #665541;
    --qc-total-bg: #f6efe3;
    --qc-rule: #ecdfcb;
    /* Declining is the one destructive thing a buyer can do here, so it gets a
       colour of its own rather than borrowing the accent. */
    --qc-danger: #a32d16;
    --qc-danger-strong: #8e1f0b;
    /* A rule strong enough to read as a control boundary. --qc-rule is a
       decorative hairline and does not clear the 3:1 WCAG 1.4.11 asks of one. */
    --qc-border-strong: #9c8768;

    --qc-card-radius: 22px;
    --qc-button-radius: 14px;
    --qc-max-width: 640px;

    --qc-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Helvetica Neue", Arial, sans-serif;
    --qc-heading-font: "Iowan Old Style", "Palatino Linotype", Palatino,
      Georgia, serif;
  }
`;

const STYLES = `
  ${THEME}

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    padding: 28px 16px 64px;
    background: var(--qc-page-bg);
    color: var(--qc-text);
    font: 16px/1.55 var(--qc-font);
    -webkit-font-smoothing: antialiased;
  }

  .wrap { max-width: var(--qc-max-width); margin: 0 auto; }

  .card {
    background: var(--qc-surface);
    border-radius: var(--qc-card-radius);
    box-shadow: 0 1px 2px rgba(59, 36, 22, .06), 0 8px 28px rgba(59, 36, 22, .07);
    overflow: hidden;
    margin-bottom: 18px;
  }

  .card__body { padding: 26px 28px 30px; }

  /* 1. Header */
  .hero {
    background: var(--qc-header-bg);
    color: var(--qc-header-text);
    padding: 30px 28px 32px;
  }
  .hero__badge {
    display: inline-block;
    padding: 5px 13px;
    border-radius: 999px;
    background: rgba(255, 255, 255, .13);
    border: 1px solid rgba(255, 255, 255, .22);
    font-size: 12.5px;
    font-weight: 600;
    letter-spacing: .02em;
  }
  .hero__title {
    font-family: var(--qc-heading-font);
    font-size: 32px;
    line-height: 1.15;
    font-weight: 600;
    margin: 14px 0 10px;
  }
  .hero__meta {
    margin: 0;
    font-size: 14px;
    color: rgba(255, 255, 255, .72);
  }

  /* 2. Line items */
  .items { list-style: none; margin: 0; padding: 0; }
  .item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 18px;
    padding: 16px 0;
    border-bottom: 1px dashed var(--qc-rule);
  }
  .item:first-child { padding-top: 0; }
  .item__title { margin: 0; font-weight: 600; }
  .item__variant { margin: 3px 0 0; font-size: 14px; color: var(--qc-muted-strong); }
  .item__meta { margin: 5px 0 0; font-size: 14px; color: var(--qc-muted); }
  .item__amount {
    margin: 0;
    font-weight: 600;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* 3. Totals */
  .totals {
    background: var(--qc-total-bg);
    border-radius: 16px;
    padding: 16px 20px;
    margin-top: 22px;
  }
  .totals__row {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    font-size: 15px;
    color: var(--qc-muted-strong);
  }
  .totals__row + .totals__row { margin-top: 10px; }
  .totals__row--grand {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--qc-rule);
    font-size: 20px;
    font-weight: 700;
    color: var(--qc-text);
  }
  .totals__row span:last-child { font-variant-numeric: tabular-nums; }

  /* 4. Tax + shipping honesty note */
  .tax-note {
    margin: 12px 2px 0;
    font-size: 13.5px;
    color: var(--qc-muted);
  }

  /* 5. Conversation */
  .thread { margin: 26px 0 0; }
  .thread__heading {
    font-family: var(--qc-heading-font);
    font-size: 19px;
    font-weight: 600;
    margin: 0 0 14px;
  }
  .thread__list { list-style: none; margin: 0; padding: 0; }
  .msgbubble {
    margin: 0 0 12px;
    padding: 14px 18px;
    border-radius: 14px;
    background: var(--qc-total-bg);
    /* The store's side gets the accent edge; the buyer's own messages are
       flush, so a glance down the thread tells the two apart before a word of
       either is read. */
    border-left: 3px solid var(--qc-rule);
  }
  .msgbubble--merchant { border-left-color: var(--qc-accent); }
  .msgbubble--customer {
    background: none;
    border-left-color: var(--qc-border-strong);
  }
  .msgbubble__meta {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 7px;
  }
  .msgbubble__who {
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: .05em;
    text-transform: uppercase;
    color: var(--qc-muted);
  }
  .msgbubble__when { font-size: 12.5px; color: var(--qc-muted); }
  /* pre-wrap is scoped to the body alone: on the bubble it would also preserve
     the template's own indentation and render it as a stray indent. */
  .msgbubble__body {
    margin: 0;
    white-space: pre-wrap;
    color: var(--qc-muted-strong);
  }

  /* Reply box. A plain form, so it works with JavaScript off. */
  .reply { margin: 18px 0 0; }
  .reply__label {
    display: block;
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  .reply__field {
    display: block;
    width: 100%;
    font: inherit;
    font-size: 15px;
    padding: 12px 14px;
    border-radius: var(--qc-button-radius);
    border: 1px solid var(--qc-border-strong);
    background: var(--qc-surface);
    color: var(--qc-text);
    resize: vertical;
  }
  .reply__field:focus {
    outline: 2px solid var(--qc-accent);
    outline-offset: 1px;
  }
  .btn--reply {
    background: none;
    color: var(--qc-text);
    border: 1px solid var(--qc-border-strong);
    font-size: 15px;
    font-weight: 600;
    margin-top: 10px;
  }
  .btn--reply:hover { border-color: var(--qc-text); }
  .reply__hint { margin: 8px 2px 0; font-size: 13px; color: var(--qc-muted); }
  .reply__sent {
    margin: 0 0 14px;
    padding: 12px 16px;
    border-radius: 12px;
    background: var(--qc-total-bg);
    font-size: 14px;
    color: var(--qc-muted-strong);
  }

  /* 6. Decision */
  .decision { margin-top: 28px; }
  .decision form { margin: 0; }
  .btn {
    display: block;
    width: 100%;
    font: inherit;
    font-weight: 700;
    font-size: 17px;
    padding: 17px 22px;
    border: 0;
    border-radius: var(--qc-button-radius);
    cursor: pointer;
    text-align: center;
    text-decoration: none;
  }
  .btn--accept {
    background: var(--qc-accent);
    color: #fff;
    box-shadow: 0 2px 10px rgba(164, 85, 43, .28);
  }
  .btn--accept:hover { background: var(--qc-accent-strong); }
  .btn--decline {
    background: none;
    color: var(--qc-muted-strong);
    font-size: 15px;
    font-weight: 500;
    padding: 14px 12px 2px;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .btn--decline:hover { color: var(--qc-text); }

  /* Confirmation step. Both choices are real buttons: an escape hatch from an
     irreversible action should not be a faint link. */
  .confirm__title {
    font-family: var(--qc-heading-font);
    font-size: 20px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  .confirm__text {
    margin: 0 0 18px;
    font-size: 15px;
    color: var(--qc-muted-strong);
  }
  .btn--danger {
    background: none;
    color: var(--qc-danger);
    border: 2px solid var(--qc-danger);
  }
  .btn--danger:hover {
    background: var(--qc-danger);
    color: #fff;
  }
  .btn--cancel {
    background: none;
    color: var(--qc-text);
    border: 1px solid var(--qc-border-strong);
    font-weight: 600;
    margin-top: 10px;
  }
  .btn--cancel:hover { border-color: var(--qc-text); }

  .btn[disabled] { opacity: .55; cursor: default; }
  .reassure {
    margin: 0 0 14px;
    text-align: center;
    font-size: 13.5px;
    color: var(--qc-muted);
  }

  /* Contact route. Appears wherever the buyer is told to reach the store, so it
     has to read as an action rather than as more prose. */
  .contact { margin: 14px 0 0; }
  .contact__link {
    color: var(--qc-accent);
    font-weight: 600;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .contact__link:hover { color: var(--qc-accent-strong); }

  /* Status / message screens */
  .msg { margin: 0; }
  .msg__title {
    font-family: var(--qc-heading-font);
    font-size: 21px;
    font-weight: 600;
    margin: 0 0 8px;
  }
  .msg__text { margin: 0 0 14px; color: var(--qc-muted-strong); }
  .msg__text:last-child { margin-bottom: 0; }
  .msg + .decision { margin-top: 22px; }
  .divider-top { border-top: 1px dashed var(--qc-rule); margin-top: 24px; padding-top: 22px; }

  @media (max-width: 480px) {
    body { padding: 16px 12px 48px; }
    .hero { padding: 24px 20px 26px; }
    .hero__title { font-size: 27px; }
    .card__body { padding: 22px 20px 24px; }
    .item { gap: 12px; }
  }
`;

function page(
  title: string,
  body: string,
  { status = 200, head = "" }: { status?: number; head?: string } = {},
): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
${head}
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Nothing here should sit in a shared cache: the URL is a bearer token
      // and the status changes the moment the buyer acts on it.
      "Cache-Control": "no-store",
    },
  });
}

/**
 * What the buyer is told about the store: what to call it, and where to reach
 * it. Resolved once per request and handed to every page-building function, so
 * a page rendered from any branch names and links the store the same way and one
 * request never makes the lookup twice.
 */
type StoreContext = { name: string; url: string | null };

/** Used before a shop is known, and when the profile lookup comes back empty. */
const NO_STORE: StoreContext = { name: "", url: null };

async function resolveStore(
  shop: string,
  admin?: AdminApiContext,
): Promise<StoreContext> {
  // No verified shop means nothing to look up and nothing safe to link to.
  if (!shop) return NO_STORE;

  // Cached, so this is normally a read of our own database rather than a live
  // Admin call, and it never throws — a failed lookup costs the nicer name and
  // the link, not the page.
  const profile = await shopProfile(shop, { admin });

  return { name: storeName(shop, profile.name), url: profile.url };
}

/**
 * The way out of a dead end.
 *
 * Every state that tells the buyer to contact the store gets this line, so the
 * instruction is never given without a way to follow it. When the storefront URL
 * could not be resolved it renders nothing and the sentence stands on its own,
 * which is what it did before — never a broken or invented link.
 *
 * Opens in a new tab so the buyer does not lose the quote they are reading, and
 * `rel` is set because the target is outside this page's control.
 */
function contactLine(store: StoreContext): string {
  if (!store.url) return "";

  const label = store.name
    ? `Visit ${escapeHtml(store.name)}`
    : "Visit the store";

  return `<p class="contact">
    <a class="contact__link" href="${escapeHtml(
      store.url,
    )}" target="_blank" rel="noopener noreferrer">${label} &rarr;</a>
  </p>`;
}

/**
 * Deliberately says nothing about whether the token exists: an unknown token,
 * a token from another shop and a malformed one all look identical from
 * outside, so this page cannot be used to probe for valid links.
 */
function notFoundPage(store: StoreContext = NO_STORE): Response {
  return page(
    "Quote not available",
    shell({
      badge: "Link not active",
      title: "This quote isn't available",
      meta: "",
      body: `<p class="msg__text">
        The link may be incorrect or no longer active. Please check the link in
        your email, or contact the store for a new one.
      </p>
      ${contactLine(store)}`,
    }),
    { status: 404 },
  );
}

function errorPage(
  heading: string,
  message: string,
  status = 400,
  store: StoreContext = NO_STORE,
): Response {
  return page(
    heading,
    shell({
      badge: "Something went wrong",
      title: heading,
      meta: "",
      body: `<p class="msg__text">${escapeHtml(message)}</p>
      ${contactLine(store)}`,
    }),
    { status },
  );
}

/**
 * The one page shape everything on this route renders into: dark header with a
 * badge, title and meta line, then a white body.
 */
function shell({
  badge,
  title,
  meta,
  body,
}: {
  badge: string;
  title: string;
  meta: string;
  body: string;
}): string {
  return `<div class="card">
    <header class="hero">
      <span class="hero__badge">${escapeHtml(badge)}</span>
      <h1 class="hero__title">${escapeHtml(title)}</h1>
      ${meta ? `<p class="hero__meta">${meta}</p>` : ""}
    </header>
    <div class="card__body">${body}</div>
  </div>`;
}

/**
 * Header wording per status. Presentation only — the status itself still drives
 * which actions the page offers.
 */
function heroCopy(status: string): { badge: string; title: string } {
  switch (status) {
    case "QUOTED":
      return { badge: "Awaiting your approval", title: "Here's your quote!" };
    case "REQUESTED":
      return { badge: "In progress", title: "Your quote is on its way" };
    case "ACCEPTED":
    case "CONVERTED":
      return { badge: "Accepted", title: "Thanks — you're all set!" };
    case "DECLINED":
      return { badge: "Declined", title: "Quote declined" };
    case "EXPIRED":
      return { badge: "Expired", title: "This quote has expired" };
    default:
      return { badge: status, title: "Your quote" };
  }
}

/** A cuid is too long to read out over the phone; its tail is enough. */
function quoteNumber(id: string): string {
  return id.slice(-6).toUpperCase();
}

function itemsList(quote: QuoteWithItems): string {
  const items = quote.items
    .map((item) => {
      // Converted off bigint before any arithmetic: mixing bigint with a plain
      // number throws at runtime.
      const unit = minorToNumber(item.quotedUnitPriceMinor);
      const lineTotal = unit === null ? null : unit * item.quantity;

      // Before the merchant prices the quote there is no unit price to show, so
      // the meta line drops to the quantity alone rather than inventing a zero.
      const meta =
        unit === null
          ? `Qty ${item.quantity}`
          : `Qty ${item.quantity} &middot; ${escapeHtml(
              formatMoney(unit, quote.currency),
            )} each`;

      return `<li class="item">
        <div>
          <p class="item__title">${escapeHtml(item.title)}</p>
          ${
            item.variantTitle
              ? `<p class="item__variant">${escapeHtml(item.variantTitle)}</p>`
              : ""
          }
          <p class="item__meta">${meta}</p>
        </div>
        <p class="item__amount">${escapeHtml(
          formatMoney(lineTotal, quote.currency),
        )}</p>
      </li>`;
    })
    .join("");

  return `<ul class="items">${items}</ul>`;
}

/**
 * Only figures we actually hold are printed: the line subtotal and the stored
 * quote total. Tax and shipping are deliberately absent rather than guessed —
 * Shopify calculates those at checkout, and a made-up tax line on a quote is
 * exactly the kind of number a buyer would hold the store to.
 */
function totalsBox(quote: QuoteWithItems): string {
  const allPriced =
    quote.items.length > 0 &&
    quote.items.every((item) => item.quotedUnitPriceMinor !== null);

  const subtotalMinor = allPriced
    ? quote.items.reduce(
        (sum, item) =>
          sum + (minorToNumber(item.quotedUnitPriceMinor) ?? 0) * item.quantity,
        0,
      )
    : null;

  const totalMinor = minorToNumber(quote.quotedTotalMinor);

  if (subtotalMinor === null && totalMinor === null) return "";

  const rows = [
    subtotalMinor === null
      ? ""
      : `<div class="totals__row">
           <span>Subtotal</span>
           <span>${escapeHtml(formatMoney(subtotalMinor, quote.currency))}</span>
         </div>`,
    totalMinor === null
      ? ""
      : `<div class="totals__row totals__row--grand">
           <span>Total</span>
           <span>${escapeHtml(formatMoney(totalMinor, quote.currency))}</span>
         </div>`,
  ].join("");

  return `<div class="totals">${rows}</div>
    <p class="tax-note">Taxes and shipping are calculated at checkout.</p>`;
}

/**
 * Double-submit guard, shared by every decision form on this page.
 *
 * Progressive enhancement only: with JavaScript off the buttons simply stay
 * enabled, and the server's own compare-and-set is what actually stops a quote
 * being acted on twice.
 */
const ONCE_SCRIPT = `<script>
    document.querySelectorAll('form[data-once]').forEach(function (form) {
      form.addEventListener('submit', function () {
        document.querySelectorAll('form[data-once] button').forEach(function (b) {
          b.disabled = true;
        });
      });
    });
  </script>`;

/** The buyer's decision form. Only rendered while the quote is still QUOTED. */
function decisionForm(token: string): string {
  const safeToken = escapeHtml(token);

  return `<div class="decision">
    <p class="reassure">
      Accepting takes you straight to secure checkout at the prices above.
      We'll email you the same payment link.
    </p>
    <form method="post" data-once>
      <input type="hidden" name="token" value="${safeToken}">
      <input type="hidden" name="intent" value="accept">
      <button type="submit" class="btn btn--accept">Accept &amp; check out &rarr;</button>
    </form>
    <form method="post" data-once>
      <input type="hidden" name="token" value="${safeToken}">
      <input type="hidden" name="intent" value="decline">
      <button type="submit" class="btn btn--decline">Decline this quote</button>
    </form>
  </div>
  ${ONCE_SCRIPT}`;
}

/**
 * The confirmation step for declining.
 *
 * Declining is final: it closes the quote and there is no way back from the
 * buyer's side. So the first click lands here rather than on the database, and
 * the buyer answers a question they can actually see the consequences of. It
 * replaces the decision buttons in place, on the same page, so the items and the
 * total they are about to turn down are still in front of them.
 *
 * Both choices are forms rather than links. A link would have to rebuild the app
 * proxy's signed query string to get back to this page, whereas a POST with no
 * action attribute goes to the current URL and carries that signature untouched.
 * It also means the whole step works with JavaScript turned off — which this
 * page has always supported and must keep supporting.
 */
function declineConfirmForm(token: string): string {
  const safeToken = escapeHtml(token);

  return `<div class="decision">
    <p class="confirm__title">Decline this quote?</p>
    <p class="confirm__text">
      This can&rsquo;t be undone. The quote closes and the prices above stop
      being available to you &mdash; you would have to ask the store to send a
      new one.
    </p>
    <form method="post" data-once>
      <input type="hidden" name="token" value="${safeToken}">
      <input type="hidden" name="intent" value="decline-confirm">
      <button type="submit" class="btn btn--danger">Yes, decline this quote</button>
    </form>
    <form method="post" data-once>
      <input type="hidden" name="token" value="${safeToken}">
      <input type="hidden" name="intent" value="review">
      <button type="submit" class="btn btn--cancel">Cancel &mdash; keep reviewing</button>
    </form>
  </div>
  ${ONCE_SCRIPT}`;
}

/**
 * What just happened to a reply the buyer submitted, when one did.
 *
 * "throttled" is the only refusal the buyer can see, and it is deliberately
 * visible: their message is not on the thread, so saying nothing would leave
 * them believing it was.
 */
type MessageOutcome = "sent" | "throttled";

/**
 * The conversation, oldest first, with the reply box under it.
 *
 * Shown in every status, and the reply box with it. A CONVERTED quote has a real
 * order behind it that the buyer may have a question about; a DECLINED or
 * EXPIRED one is exactly where "could you send me a revised quote?" belongs —
 * the status messages below have always told the buyer to contact the store in
 * those states, and this is finally what they contact it *with*. Only the
 * *decision* is terminal; talking never is.
 *
 * The buyer's original request note is the first entry, merged in by buildThread
 * rather than stored twice. Their own messages are labelled "You", so nobody is
 * ever shown their own words as if the shop had said them.
 */
function threadSection(
  quote: QuoteWithItems,
  store: StoreContext,
  outcome?: MessageOutcome,
): string {
  const messages = buildThread(quote, quote.messages);

  const merchantLabel = store.name
    ? `Note from ${escapeHtml(store.name)}`
    : "Note from the store";

  const bubbles = messages
    .map((message) => {
      const merchant = message.author === "MERCHANT";

      return `<li class="msgbubble msgbubble--${merchant ? "merchant" : "customer"}">
        <p class="msgbubble__meta">
          <span class="msgbubble__who">${merchant ? merchantLabel : "You"}</span>
          <span class="msgbubble__when">${escapeHtml(
            formatDateTime(message.createdAt),
          )}</span>
        </p>
        <p class="msgbubble__body">${escapeHtml(message.body)}</p>
      </li>`;
    })
    .join("");

  const safeToken = escapeHtml(quote.publicToken ?? "");

  // A plain POST with no action attribute goes back to the current URL, which
  // still carries Shopify's signature — the same reason the decline steps are
  // forms rather than links, and what makes the whole exchange work with
  // JavaScript turned off. `data-once` only disables the buttons when scripting
  // happens to be on; the server's own duplicate window is what actually stops a
  // double submit.
  const replyForm = `<form class="reply" method="post" data-once>
      <input type="hidden" name="token" value="${safeToken}">
      <input type="hidden" name="intent" value="message">
      <label class="reply__label" for="qc-reply">Reply to the store</label>
      <textarea
        class="reply__field"
        id="qc-reply"
        name="body"
        rows="4"
        maxlength="${MESSAGE_MAX_LENGTH}"
        placeholder="Ask a question about this quote…"
      ></textarea>
      <button type="submit" class="btn btn--reply">Send message</button>
      <p class="reply__hint">
        The store is emailed your message and can reply here.
      </p>
    </form>`;

  return `<section class="thread divider-top">
    <h2 class="thread__heading">Conversation</h2>
    ${
      outcome === "sent"
        ? `<p class="reply__sent">Your message has been sent to the store.</p>`
        : outcome === "throttled"
          ? `<p class="reply__sent">
               You&rsquo;ve sent several messages in the last few minutes, so
               this one wasn&rsquo;t added. Give the store a moment to reply.
             </p>`
          : ""
    }
    ${bubbles ? `<ul class="thread__list">${bubbles}</ul>` : ""}
    ${replyForm}
  </section>`;
}

/**
 * The status-specific message under the line items. Everything that is not
 * QUOTED is terminal from the buyer's side, so each case explains what happened
 * instead of offering an action that would be rejected anyway.
 */
function statusMessage(quote: QuoteWithItems, store: StoreContext): string {
  switch (quote.status) {
    case "REQUESTED":
      return `<div class="msg">
        <p class="msg__title">Still being prepared</p>
        <p class="msg__text">
          The store hasn't finished pricing this quote yet. You'll be able to
          accept it from this same link once they send it over.
        </p>
      </div>`;

    case "CONVERTED":
      return `<div class="msg">
        <p class="msg__title">You've accepted this quote</p>
        <p class="msg__text">An order has been created at the quoted prices.</p>
        ${
          quote.invoiceUrl
            ? `<div class="decision">
                 <a class="btn btn--accept" href="${escapeHtml(
                   quote.invoiceUrl,
                 )}">Go to payment &rarr;</a>
               </div>`
            : `<p class="msg__text">
                 Check your email for the payment link, or contact the store if
                 it hasn't arrived.
               </p>
               ${contactLine(store)}`
        }
      </div>`;

    case "ACCEPTED":
      return `<div class="msg">
        <p class="msg__title">You've accepted this quote</p>
        <p class="msg__text">
          The store is finalising your order and will send the payment link by
          email shortly.
        </p>
      </div>`;

    case "DECLINED":
      return `<div class="msg">
        <p class="msg__title">You declined this quote</p>
        <p class="msg__text">
          No order was created. Contact the store if you'd like them to send a
          new quote.
        </p>
        ${contactLine(store)}
      </div>`;

    case "EXPIRED":
      return `<div class="msg">
        <p class="msg__title">This quote has expired</p>
        <p class="msg__text">
          The prices are no longer valid. Contact the store to request an
          updated quote.
        </p>
        ${contactLine(store)}
      </div>`;

    default:
      return "";
  }
}

/**
 * `store` is resolved once per request by the loader or action and handed in,
 * rather than looked up here: naming the store is a cached Admin read, and this
 * function is called from a dozen branches that must not each fire one.
 */
function quotePage(
  quote: QuoteWithItems,
  store: StoreContext,
  {
    confirmingDecline = false,
    messageOutcome,
  }: {
    confirmingDecline?: boolean;
    messageOutcome?: MessageOutcome;
  } = {},
): Response {
  const { badge, title } = heroCopy(quote.status);

  const meta = [
    `From ${escapeHtml(store.name)}`,
    `#${escapeHtml(quoteNumber(quote.id))}`,
    escapeHtml(formatDate(quote.createdAt)),
  ].join(" &middot; ");

  // QUOTED is the only state that offers a decision; every other state explains
  // itself instead, below the same line items so the buyer can still see what
  // was quoted.
  const footer =
    quote.status === "QUOTED"
      ? confirmingDecline
        ? declineConfirmForm(quote.publicToken ?? "")
        : decisionForm(quote.publicToken ?? "")
      : `<div class="divider-top">${statusMessage(quote, store)}</div>`;

  // The conversation sits below the decision, not above it: the buyer came here
  // to accept or decline, and burying that under a thread would make the page
  // about the correspondence instead of the quote. It is deliberately *not*
  // hidden while the decline confirmation is up — the buyer stepping back from
  // "yes, decline" to ask a question first is the best outcome on that screen.
  const body = shell({
    badge,
    title,
    meta,
    body: `${itemsList(quote)}
      ${totalsBox(quote)}
      ${footer}
      ${threadSection(quote, store, messageOutcome)}`,
  });

  return page("Your quote", body);
}

/**
 * Hand the buyer off to Shopify's checkout page for the draft order.
 *
 * Deliberately not a 302: the app proxy *follows* 30x responses itself rather
 * than passing them to the browser, so the checkout page would come back
 * rendered under the /apps/quotecrate/quote URL with its relative assets
 * pointing at the wrong path. Sending an HTML page that navigates the browser
 * puts the buyer on the real checkout URL instead. The meta refresh covers the
 * no-JavaScript case, and the button covers both.
 */
function redirectToPaymentPage(invoiceUrl: string): Response {
  const safeUrl = escapeHtml(invoiceUrl);

  return page(
    "Taking you to payment",
    `${shell({
      badge: "Accepted",
      title: "Thanks — you're all set!",
      meta: "",
      body: `<p class="msg__text">Taking you to the payment page…</p>
        <div class="decision">
          <a id="pay" class="btn btn--accept" href="${safeUrl}">Continue to payment &rarr;</a>
        </div>
        <p class="tax-note" style="text-align:center">
          We've also emailed this payment link to you.
        </p>`,
    })}
    <script>
      // Read the URL back off the link rather than inlining it, so the value
      // never has to be escaped for a JavaScript string context.
      var pay = document.getElementById('pay');
      if (pay) window.location.replace(pay.href);
    </script>`,
    { head: `<meta http-equiv="refresh" content="0;url=${safeUrl}">` },
  );
}

function readToken(value: FormDataEntryValue | string | null): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, TOKEN_MAX_LENGTH);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Verified first, so an unsigned probe learns nothing — not even whether a
  // token is valid.
  const { session } = await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";
  const token = readToken(url.searchParams.get("token"));

  // Resolved before the first exit: "this quote isn't available" is reachable
  // from the very first check, and that is exactly the page a buyer most needs a
  // way out of.
  const store = await resolveStore(shop);

  if (!shop || !token) return notFoundPage(store);

  const found = await findQuoteByToken(shop, token);
  if (!found) return notFoundPage(store);

  // An accept that died before Shopify answered leaves the quote ACCEPTED with
  // no draft order, and this page then shows the buyer "the store is finalising
  // your order" for ever, with nothing to click. Releasing an abandoned attempt
  // on the way in puts the quote back to QUOTED, so the page renders its Accept
  // button again and the buyer has a way forward.
  const quote = await reviveStuckAccepted(found);

  return quotePage(quote, store);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);

  if (request.method !== "POST") {
    return errorPage(
      "Method not allowed",
      "This page only accepts form submissions.",
      405,
    );
  }

  const url = new URL(request.url);
  const shop = session?.shop ?? url.searchParams.get("shop") ?? "";

  const formData = await request.formData();
  const intent = formData.get("intent");
  const token = readToken(formData.get("token")) ||
    readToken(url.searchParams.get("token"));

  // Same lookup the loader does, so every page this action renders names and
  // links the store the same way as the page the buyer just submitted from.
  const store = await resolveStore(shop, admin ?? undefined);

  if (!shop || !token) return notFoundPage(store);

  const found = await findQuoteByToken(shop, token);
  if (!found) return notFoundPage(store);

  // Same recovery the loader performs, repeated here so a form posted from a
  // page that was rendered before the release still goes through.
  const quote = await reviveStuckAccepted(found);

  if (intent === "message") {
    const body = readMessageBody(formData.get("body"));

    // An empty submit is the buyer pressing Send on an empty box. Nothing is
    // written and nothing is claimed — the page simply comes back as it was.
    if (!body) return quotePage(quote, store);

    const appended = await appendMessage({
      quoteId: quote.id,
      shop,
      author: "CUSTOMER",
      body,
    });

    // Only a message that was really stored is notified, so one stored message
    // is one email. A duplicate is the buyer's double submit or a reloaded POST;
    // their message is already on the thread and the merchant has already been
    // told, so a second mail would be noise.
    //
    // Awaited rather than fired and forgotten: it never throws, and letting the
    // response race it would risk the process finishing the request first.
    if (appended.status === "created") {
      await notifyMerchantOfMessage({
        shop,
        quoteId: quote.id,
        customerName: quote.customerName,
        customerEmail: quote.customerEmail,
        body: appended.message.body,
      });
    }

    // Re-read so the buyer's own message is on the page that comes back: the
    // row loaded at the top of this action predates the append.
    const current = await findQuoteByToken(shop, token);
    if (!current) return notFoundPage(store);

    // "Sent to the store" is claimed only when the message is genuinely on the
    // thread, which is what the merchant reads on their own dashboard — the
    // email is a nudge on top of that, so a mail failure does not make the
    // sentence untrue. A rate-limited message is not on the thread, so it gets
    // the truth instead.
    return quotePage(current, store, {
      messageOutcome: appended.status === "rate-limited" ? "throttled" : "sent",
    });
  }

  if (intent === "decline") {
    // The first click only asks. Nothing is written here — the quote is still
    // QUOTED when this returns, and stays that way unless the buyer confirms on
    // the screen it renders.
    //
    // A page left open from before this step existed posts this same intent
    // expecting an immediate decline. It now gets the question instead, which is
    // the safe direction for the change to fail in.
    return quotePage(quote, store, { confirmingDecline: true });
  }

  if (intent === "review") {
    // "Cancel — keep reviewing" from that screen. Also writes nothing; it just
    // puts the decision buttons back.
    return quotePage(quote, store);
  }

  if (intent === "decline-confirm") {
    // Conditional on the current status so a stale tab can't decline a quote
    // the buyer has already accepted and paid for.
    const declined = await prisma.quote.updateMany({
      where: { id: quote.id, shop, status: "QUOTED" },
      data: { status: "DECLINED" },
    });

    if (declined.count === 0) {
      // Someone else already moved it; show whatever it is now.
      const current = await findQuoteByToken(shop, token);
      return current ? quotePage(current, store) : notFoundPage(store);
    }

    return quotePage({ ...quote, status: "DECLINED" }, store);
  }

  if (intent !== "accept") {
    return errorPage(
      "Unsupported action",
      "That action isn't available.",
      400,
      store,
    );
  }

  if (quote.status === "CONVERTED") {
    // Already converted: show the existing payment link rather than creating a
    // second draft order for the same quote.
    return quotePage(quote, store);
  }

  // An abandoned attempt has already been released back to QUOTED above; what
  // is left here is a quote that genuinely cannot be accepted.
  if (quote.status !== "QUOTED") {
    return quotePage(quote, store);
  }

  if (!admin) {
    return errorPage(
      "We couldn't process this right now",
      "The store isn't reachable at the moment. Please try again shortly, or contact the store.",
      503,
      store,
    );
  }

  // Claim the quote before doing any work: this is a compare-and-set in SQL, so
  // if two clicks race, exactly one of them gets count === 1 and only that one
  // creates a draft order. ACCEPTED is the in-between state — buyer has said
  // yes, the order does not exist yet.
  const claimed = await prisma.quote.updateMany({
    where: { id: quote.id, shop, status: "QUOTED" },
    data: { status: "ACCEPTED" },
  });

  if (claimed.count === 0) {
    const current = await findQuoteByToken(shop, token);
    return current ? quotePage(current, store) : notFoundPage(store);
  }

  // The same engine the merchant's "Convert to order" button uses, including
  // its shop-currency guard, so both paths bill exactly the quoted amounts.
  const result = await convertQuoteToDraftOrder(admin, {
    id: quote.id,
    customerName: quote.customerName,
    customerEmail: quote.customerEmail,
    company: quote.company,
    currency: quote.currency,
    note: quote.note,
    items: quote.items.map((item) => ({
      title: item.title,
      variantId: item.variantId,
      quantity: item.quantity,
      quotedUnitPriceMinor: minorToNumber(item.quotedUnitPriceMinor),
    })),
  });

  if (!result.ok) {
    // Released back to QUOTED so the buyer can retry and the merchant's own
    // "Convert to order" fallback still works. The buyer is never shown the raw
    // Shopify errors — those are for the merchant.
    await prisma.quote.updateMany({
      where: { id: quote.id, shop, status: "ACCEPTED" },
      data: { status: "QUOTED" },
    });

    console.error(
      `[quotecrate] Buyer accept failed for quote ${quote.id}: ${result.errors.join(
        " | ",
      )}`,
    );

    return errorPage(
      "We couldn't complete your order",
      "Something went wrong while creating your order. Please try again, or contact the store — they can send you a payment link directly.",
      502,
      store,
    );
  }

  // Persisted before the email is attempted: the draft order exists in Shopify
  // either way, so a send failure must never cost us the payment link.
  await prisma.quote.update({
    where: { id: quote.id },
    data: {
      status: "CONVERTED",
      draftOrderId: result.draftOrderId,
      invoiceUrl: result.invoiceUrl,
    },
  });

  // Shopify sends this itself, so there is no mail provider to configure. A
  // failure here is not fatal — the buyer is already on their way to checkout.
  const invoice = await sendDraftOrderInvoice(
    admin,
    result.draftOrderId,
    quote.customerEmail,
  );

  if (!invoice.ok) {
    console.error(
      `[quotecrate] Invoice email failed for quote ${quote.id}: ${invoice.errors.join(
        " | ",
      )}`,
    );
  }

  if (!result.invoiceUrl) {
    // Converted, but Shopify returned no checkout URL; the merchant can still
    // find the draft order in their admin.
    return quotePage(
      {
        ...quote,
        status: "CONVERTED",
        draftOrderId: result.draftOrderId,
        invoiceUrl: null,
      },
      store,
    );
  }

  return redirectToPaymentPage(result.invoiceUrl);
};
