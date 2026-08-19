import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { redirect, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  convertQuoteToDraftOrder,
  sendDraftOrderInvoice,
} from "../draft-order.server";
import {
  PriceInputError,
  minorFromInput,
  minorToNumber,
  formatDate,
  formatMoney,
  inputFromMinor,
  statusTone,
} from "../quotes";
import { customerQuoteUrl, newPublicToken } from "../public-token.server";
import { emailQuoteToCustomer } from "../quote-ready.server";
import { reviveStuckAccepted } from "../quote-recovery.server";
import { adoptShopCurrency, shopCurrency } from "../shop-currency.server";

/**
 * Statuses a quote can still be priced and sent from.
 *
 * REQUESTED is the first send. QUOTED is a re-price before the buyer has done
 * anything — the public token is deliberately reused on a re-send, so this is a
 * supported path rather than an accident.
 *
 * Everything after that is excluded on purpose: once a quote is ACCEPTED or
 * CONVERTED a draft order exists and the buyer may already have paid, so
 * rewriting the total and dropping the status back to QUOTED would invite a
 * second order for the same quote. DECLINED and EXPIRED are closed too.
 */
const SENDABLE_STATUSES = ["REQUESTED", "QUOTED"] as const;

/** Why a send was refused, in words a merchant can act on. */
const SEND_REFUSAL: Record<string, string> = {
  ACCEPTED:
    "The customer has already accepted this quote, so its pricing can no longer be changed.",
  CONVERTED:
    "This quote has already been converted to an order, so its pricing can no longer be changed.",
  DECLINED:
    "The customer declined this quote, so it can no longer be sent. Create a new quote instead.",
  EXPIRED: "This quote has expired, so it can no longer be sent.",
};

/**
 * Same parse as the server, but for the live preview only, so a half-typed
 * value contributes nothing instead of throwing while the merchant is still
 * mid-keystroke. The server re-parses and reports the real error on submit.
 */
function previewMinor(value: string, currency: string): number | null {
  try {
    return minorFromInput(value, currency);
  } catch {
    return null;
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // The shop filter is part of the lookup, not a post-hoc check, so one shop
  // can never read another shop's quote by guessing an id.
  const found = await prisma.quote.findFirst({
    where: { id: params.id, shop: session.shop },
    include: { items: { orderBy: { title: "asc" } } },
  });

  if (!found) {
    throw new Response("Quote not found", { status: 404 });
  }

  // A conversion that died before it produced a draft order leaves the quote
  // ACCEPTED and unactionable; releasing it here is what puts the "Convert to
  // order" button back on this page.
  const revived = await reviveStuckAccepted(found);

  // The last moment before the merchant types an amount, so it is where a quote
  // created while the shop currency could not be read gets the real one.
  const currency = await shopCurrency(session.shop, { admin });
  const quote = await adoptShopCurrency(revived, currency);

  return {
    // Only set when the quote's currency disagrees with the shop's and could
    // not be corrected, i.e. the quote already carries prices. Surfaced rather
    // than swallowed: converting it would invoice converted amounts, so the
    // merchant has to know before they send it.
    shopCurrencyMismatch:
      currency && currency !== quote.currency ? currency : null,
    // Built here rather than in the browser: the shop domain comes from the
    // authenticated session, so the link can never be assembled from whatever
    // host the admin iframe happens to be on.
    customerQuoteUrl: quote.publicToken
      ? customerQuoteUrl(session.shop, quote.publicToken)
      : null,
    quote: {
      id: quote.id,
      customerName: quote.customerName,
      customerEmail: quote.customerEmail,
      company: quote.company,
      status: quote.status,
      currency: quote.currency,
      note: quote.note,
      // Money columns are BigInt, and bigint cannot be serialised into the
      // loader payload, so they cross back to number here.
      quotedTotalMinor: minorToNumber(quote.quotedTotalMinor),
      draftOrderId: quote.draftOrderId,
      invoiceUrl: quote.invoiceUrl,
      createdAt: formatDate(quote.createdAt),
      items: quote.items.map((item) => ({
        id: item.id,
        title: item.title,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        quotedUnitPriceMinor: minorToNumber(item.quotedUnitPriceMinor),
      })),
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const found = await prisma.quote.findFirst({
    where: { id: params.id, shop: session.shop },
    include: { items: true },
  });

  if (!found) {
    throw new Response("Quote not found", { status: 404 });
  }

  // Same recovery the loader performs, repeated here so the button in a tab
  // that was open before the release still works on its own.
  const quote = await reviveStuckAccepted(found);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    // deleteMany with the shop filter rather than delete-by-id, so one shop can
    // never delete another shop's quote by guessing an id. Line items go with
    // it through the QuoteItem cascade already declared in the schema.
    await prisma.quote.deleteMany({
      where: { id: quote.id, shop: session.shop },
    });

    // The record this page renders is gone, so redirect instead of returning
    // to a detail view that would immediately 404.
    return redirect("/app/quotes");
  }

  if (intent === "convert") {
    // Guarded here rather than only in the UI: a stale tab must not be able to
    // create a second draft order for a quote that is already converted.
    //
    // Reported as information rather than an error: the merchant pressed a
    // button and the quote is an order, which is the outcome they wanted. A red
    // "something went wrong" banner for a double-click is alarming and untrue.
    if (quote.status === "CONVERTED") {
      return { alreadyConverted: true as const };
    }

    // An abandoned attempt has already been released back to QUOTED above, so
    // this refuses only what is genuinely not convertible.
    if (quote.status !== "QUOTED") {
      return {
        error: "Only quotes with the QUOTED status can be converted to an order.",
      };
    }

    // Claim the quote before doing any work, exactly as the buyer's accept path
    // does in apps.quotecrate.quote.tsx. The status check above is read-then-act
    // and cannot stop a race on its own: two merchant clicks, or a merchant
    // convert landing at the same moment as a buyer accept, would both see
    // QUOTED and both create a draft order. This is a compare-and-set in SQL, so
    // exactly one caller gets count === 1 and only that one bills the customer.
    // Both paths claim the same way, so they cannot both win.
    const claimed = await prisma.quote.updateMany({
      where: { id: quote.id, shop: session.shop, status: "QUOTED" },
      data: { status: "ACCEPTED" },
    });

    if (claimed.count === 0) {
      return {
        error:
          "This quote was just processed somewhere else — the customer may have accepted it. Reload the page to see its current status.",
      };
    }

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

    // Released back to QUOTED so the merchant can fix the cause and retry, and
    // so the buyer's own accept button keeps working — same rollback the buyer
    // path performs.
    if (!result.ok) {
      await prisma.quote.updateMany({
        where: { id: quote.id, shop: session.shop, status: "ACCEPTED" },
        data: { status: "QUOTED" },
      });

      return { error: result.errors.join("\n") };
    }

    // Persisted before the email is attempted: the draft order exists in
    // Shopify either way, so a send failure must never cost us the CONVERTED
    // record or the payment link.
    await prisma.quote.update({
      where: { id: quote.id },
      data: {
        status: "CONVERTED",
        draftOrderId: result.draftOrderId,
        invoiceUrl: result.invoiceUrl,
      },
    });

    // Shopify sends this one itself, so there is no mail provider to configure.
    const invoice = await sendDraftOrderInvoice(
      admin,
      result.draftOrderId,
      quote.customerEmail,
    );

    return {
      converted: true,
      draftOrderName: result.draftOrderName,
      invoiceUrl: result.invoiceUrl,
      emailSent: invoice.ok,
      emailTo: quote.customerEmail,
      emailError: invoice.ok ? undefined : invoice.errors.join("\n"),
    };
  }

  if (intent !== "send") {
    return { error: "Unsupported action" };
  }

  // Guarded here rather than only in the UI: the Send button is hidden once a
  // quote leaves REQUESTED, but a tab left open from before still holds a form
  // that posts this intent. Without this an already-converted quote could be
  // rewritten back to QUOTED and converted a second time.
  if (
    !(SENDABLE_STATUSES as readonly string[]).includes(quote.status)
  ) {
    return {
      error:
        SEND_REFUSAL[quote.status] ??
        "This quote can no longer be sent from its current status.",
    };
  }

  const rawPrices = formData.get("prices");
  if (typeof rawPrices !== "string") {
    return { error: "No pricing information was submitted." };
  }

  // Parsed defensively: this is a form field, so a truncated submit or a stale
  // client can deliver something that is not JSON at all. Left unguarded it
  // threw and the merchant got a 500 instead of a banner telling them nothing
  // was saved.
  let prices: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(rawPrices);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("prices is not an object");
    }
    prices = parsed as Record<string, string>;
  } catch {
    return {
      error:
        "The prices on this page couldn't be read. Reload the page and enter them again — nothing has been saved.",
    };
  }

  // Every line must be priced before the quote can go out, otherwise the
  // total would silently understate what the buyer is being asked to pay.
  const priced: { id: string; minor: number }[] = [];
  for (const item of quote.items) {
    let minor: number | null;
    try {
      // Parsed against the quote's own currency, so "12.345" keeps its third
      // decimal in BHD and "10000" is ten thousand won rather than a hundred.
      minor = minorFromInput(prices[item.id] ?? "", quote.currency);
    } catch (error) {
      // An over-large price is refused rather than stored: it would survive the
      // write and then throw on every later read, taking the quote list with it.
      if (error instanceof PriceInputError && error.reason === "too-large") {
        return {
          error: `The unit price for "${item.title}" is too large.`,
        };
      }

      return {
        error: `Enter a valid number for the unit price of "${item.title}".`,
      };
    }

    if (minor === null) {
      return { error: `The unit price for "${item.title}" is empty.` };
    }

    priced.push({ id: item.id, minor });
  }

  const byId = new Map(priced.map((line) => [line.id, line.minor]));
  const totalMinor = quote.items.reduce(
    (sum, item) => sum + byId.get(item.id)! * item.quantity,
    0,
  );

  // Per-line ceilings bound each term, but a quote can carry many lines, so the
  // sum is checked too rather than assumed.
  if (!Number.isSafeInteger(totalMinor)) {
    return {
      error:
        "The total for this quote is too large to be recorded accurately. Lower the unit prices or split the quote.",
    };
  }

  // A single free line is a real thing to quote — a sample, or an item included
  // with the order — so a zero unit price is accepted. A quote whose whole total
  // is zero is not: it invoices the buyer for nothing, and the only way to reach
  // it is a mistake. Refused at the total rather than per line so the legitimate
  // free line keeps working.
  if (totalMinor === 0) {
    return {
      error: "This quote totals 0 — enter a price before sending.",
    };
  }

  // Minted on the first send and kept afterwards, so re-sending a quote never
  // invalidates a link the customer has already been given.
  const publicToken = quote.publicToken ?? newPublicToken();

  // One transaction so a partial write can never leave a QUOTED quote whose
  // total disagrees with its lines.
  //
  // The status update is a compare-and-set rather than a plain update: the check
  // above ran against a row read earlier, so a buyer accepting in the meantime
  // would otherwise be overwritten. If the quote has left a sendable status the
  // update matches nothing, and the line prices roll back with it — the whole
  // send becomes a no-op instead of a half-applied re-price.
  //
  // The columns are BigInt, so the numbers computed above are converted on the
  // way in. Both are whole minor units already, so this cannot lose anything.
  const sent = await prisma.$transaction(async (tx) => {
    const claimed = await tx.quote.updateMany({
      where: {
        id: quote.id,
        shop: session.shop,
        status: { in: [...SENDABLE_STATUSES] },
      },
      data: {
        quotedTotalMinor: BigInt(totalMinor),
        status: "QUOTED",
        publicToken,
      },
    });

    if (claimed.count === 0) return false;

    for (const line of priced) {
      await tx.quoteItem.update({
        where: { id: line.id },
        data: { quotedUnitPriceMinor: BigInt(line.minor) },
      });
    }

    return true;
  });

  if (!sent) {
    return {
      error:
        "This quote changed while you were pricing it — the customer may have just accepted or declined it. Reload the page to see its current status.",
    };
  }

  const quoteUrl = customerQuoteUrl(session.shop, publicToken);

  // The whole point of "Send quote": the customer is told, and the page reports
  // truthfully whether they were.
  const customerEmail = await emailQuoteToCustomer({
    shop: session.shop,
    admin,
    quote,
    unitPriceMinorById: byId,
    totalMinor,
    quoteUrl,
  });

  return {
    sent: true,
    totalMinor,
    customerQuoteUrl: quoteUrl,
    ...customerEmail,
  };
};

export default function QuoteDetail() {
  const { quote, customerQuoteUrl, shopCurrencyMismatch } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const [prices, setPrices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      quote.items.map((item) => [
        item.id,
        inputFromMinor(item.quotedUnitPriceMinor, quote.currency),
      ]),
    ),
  );

  // Which button was pressed last, so the error banner can name the operation
  // that actually failed.
  const [lastIntent, setLastIntent] = useState<"send" | "convert">("send");

  const isSubmitting = fetcher.state !== "idle";
  const actionError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;
  const sent = fetcher.data && "sent" in fetcher.data ? fetcher.data.sent : false;

  // How the customer's "your quote is ready" email went on the submission that
  // just finished. Undefined outside a send. Named apart from the conversion's
  // own `emailSent` below, which reports the Shopify invoice email instead —
  // the two must never light up each other's banners.
  const quoteEmail =
    fetcher.data && "quoteEmail" in fetcher.data
      ? fetcher.data.quoteEmail
      : undefined;
  const quoteEmailTo =
    fetcher.data && "quoteEmailTo" in fetcher.data
      ? fetcher.data.quoteEmailTo
      : undefined;
  const quoteEmailError =
    fetcher.data && "quoteEmailError" in fetcher.data
      ? fetcher.data.quoteEmailError
      : undefined;
  const converted =
    fetcher.data && "converted" in fetcher.data ? fetcher.data.converted : false;

  // A second click on a conversion that already succeeded. Not an error, and
  // not a fresh conversion either — so it gets its own calm banner rather than
  // the red one or the "invoice emailed" toast.
  const alreadyConverted =
    fetcher.data && "alreadyConverted" in fetcher.data
      ? fetcher.data.alreadyConverted
      : false;

  // The send action returns the link it just minted, so the section appears
  // immediately without waiting on the loader to revalidate.
  const customerLink =
    (fetcher.data && "customerQuoteUrl" in fetcher.data
      ? fetcher.data.customerQuoteUrl
      : null) ?? customerQuoteUrl;

  // Present only on a completed conversion, so `undefined` means "no conversion
  // in this submission" and is distinct from a failed send.
  const emailSent =
    fetcher.data && "emailSent" in fetcher.data
      ? fetcher.data.emailSent
      : undefined;
  const emailTo =
    fetcher.data && "emailTo" in fetcher.data ? fetcher.data.emailTo : undefined;
  const emailError =
    fetcher.data && "emailError" in fetcher.data
      ? fetcher.data.emailError
      : undefined;

  // One button per status: prices are only editable while the quote is still a
  // request, and a CONVERTED quote offers no action that would re-convert it.
  const canSend = quote.status === "REQUESTED";
  const canConvert = quote.status === "QUOTED";

  useEffect(() => {
    if (!sent) return;

    // The button says "Send quote", so the toast has to report the *email*, not
    // the save. Claiming "Quote sent" when nothing reached the customer is
    // exactly the lie this replaced.
    if (quoteEmail === "sent") {
      shopify.toast.show(`Quote emailed to ${quoteEmailTo}`);
      return;
    }

    if (quoteEmail === "skipped") {
      shopify.toast.show(
        "Prices saved — the customer was already emailed a moment ago",
      );
      return;
    }

    shopify.toast.show("Prices saved, but the customer wasn't emailed");
  }, [sent, quoteEmail, quoteEmailTo, shopify]);

  useEffect(() => {
    if (!converted) return;

    shopify.toast.show(
      emailSent
        ? "Invoice emailed to the customer"
        : "Draft order created (invoice email failed)",
    );
  }, [converted, emailSent, shopify]);

  // Live total: recomputed from the inputs, blank lines simply contribute 0.
  // Uses the same parser as the server, so the preview cannot disagree with
  // what gets saved — including the currency's own number of decimals.
  const runningTotalMinor = useMemo(() => {
    return quote.items.reduce((sum, item) => {
      const minor = previewMinor(prices[item.id] ?? "", quote.currency);
      if (minor === null) return sum;
      return sum + minor * item.quantity;
    }, 0);
  }, [prices, quote.items, quote.currency]);

  // Every submit goes through here so that a second click while the first is
  // still in flight is dropped rather than sent. Convert creates a real draft
  // order, so the double click it used to allow ended in a red "already
  // converted" banner sitting on top of a conversion that had worked — the
  // buyer-facing accept form has been guarded the same way from the start.
  const submit = (intent: "send" | "convert", body: Record<string, string>) => {
    if (fetcher.state !== "idle") return;

    setLastIntent(intent);
    fetcher.submit({ intent, ...body }, { method: "POST" });
  };

  const send = () => submit("send", { prices: JSON.stringify(prices) });

  const convert = () => submit("convert", {});

  const copy = async (value: string, confirmation: string) => {
    try {
      await navigator.clipboard.writeText(value);
      shopify.toast.show(confirmation);
    } catch {
      shopify.toast.show("Couldn't copy. Select the link and copy it manually.");
    }
  };

  const copyInvoiceUrl = () => {
    if (!quote.invoiceUrl) return;
    return copy(quote.invoiceUrl, "Payment link copied");
  };

  const copyCustomerQuoteUrl = () => {
    if (!customerLink) return;
    return copy(customerLink, "Customer quote link copied");
  };

  // Irreversible and cascades to the line items, so it is confirmed first.
  const deleteQuote = () => {
    if (fetcher.state !== "idle") return;

    if (
      !window.confirm(
        `Delete the quote from ${quote.customerName}? This also removes its line items and can't be undone.`,
      )
    ) {
      return;
    }

    fetcher.submit({ intent: "delete" }, { method: "POST" });
  };

  return (
    <s-page heading={quote.customerName}>
      <s-link slot="breadcrumb-actions" href="/app/quotes">
        Quotes
      </s-link>
      {canSend && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={send}
          {...(isSubmitting ? { loading: true } : {})}
        >
          Send quote
        </s-button>
      )}
      {canConvert && (
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={convert}
          {...(isSubmitting ? { loading: true } : {})}
        >
          Convert to order
        </s-button>
      )}
      <s-button
        slot="secondary-actions"
        tone="critical"
        onClick={deleteQuote}
        {...(isSubmitting ? { disabled: true } : {})}
      >
        Delete
      </s-button>

      {actionError && (
        <s-banner
          tone="critical"
          heading={
            lastIntent === "convert"
              ? "Couldn't convert this quote to an order"
              : "Couldn't send this quote"
          }
        >
          <s-paragraph>{actionError}</s-paragraph>
        </s-banner>
      )}

      {alreadyConverted && (
        <s-banner tone="info" heading="This quote is already an order">
          <s-paragraph>
            Nothing further was created. The draft order and its payment link
            are below.
          </s-paragraph>
        </s-banner>
      )}

      {shopCurrencyMismatch && (
        <s-banner
          tone="warning"
          heading={`This quote is priced in ${quote.currency}, but your store sells in ${shopCurrencyMismatch}`}
        >
          <s-paragraph>
            Converting it would invoice the customer in{" "}
            {shopCurrencyMismatch} at converted amounts rather than the ones
            quoted here, so the conversion will be refused. Delete this quote
            and raise a new one to price it in {shopCurrencyMismatch}.
          </s-paragraph>
        </s-banner>
      )}

      {quoteEmail === "failed" && (
        <s-banner tone="warning" heading="The customer wasn't emailed">
          <s-paragraph>
            The prices were saved and the quote link is live — only the email
            failed. Copy the customer quote link below and send it to{" "}
            {quoteEmailTo} yourself.
          </s-paragraph>
          {quoteEmailError && <s-paragraph>{quoteEmailError}</s-paragraph>}
        </s-banner>
      )}

      {emailSent === true && (
        <s-banner tone="success" heading="Invoice emailed to the customer">
          <s-paragraph>
            Shopify sent the invoice, with its payment link, to {emailTo}.
          </s-paragraph>
        </s-banner>
      )}

      {emailSent === false && (
        <s-banner tone="warning" heading="Invoice email wasn't sent">
          <s-paragraph>
            The order and its payment link were created successfully — only the
            email failed. Copy the payment link below and send it to {emailTo}
            {" "}directly.
          </s-paragraph>
          {emailError && <s-paragraph>{emailError}</s-paragraph>}
        </s-banner>
      )}

      {customerLink && (
        <s-section heading="Customer quote link">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {quote.status === "QUOTED"
                ? "This is the link your customer was emailed. They can review and accept the quote themselves, and accepting takes them straight to a payment page. Share it directly if you need to."
                : "This is the customer's own view of this quote. It shows the current status, so it stays useful after the quote is accepted or declined."}
            </s-paragraph>

            <s-url-field
              label="Customer quote link"
              value={customerLink}
              readOnly
              details="Anyone with this link can view and accept this quote, so only share it with your customer."
            />

            <s-stack direction="inline" gap="base">
              <s-button onClick={copyCustomerQuoteUrl}>Copy link</s-button>
              <s-link href={customerLink} target="_blank">
                Preview customer page
              </s-link>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {quote.status === "CONVERTED" && (
        <s-section heading="Payment link">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              This quote has been converted to a draft order. Send the payment
              link below to your customer and they can check out at the quoted
              prices.
            </s-paragraph>

            {quote.invoiceUrl ? (
              <>
                <s-url-field
                  label="Payment link"
                  value={quote.invoiceUrl}
                  readOnly
                  details="Copy this and send it to your customer."
                />
                <s-stack direction="inline" gap="base">
                  <s-button onClick={copyInvoiceUrl}>Copy link</s-button>
                  <s-link href={quote.invoiceUrl} target="_blank">
                    Open payment page
                  </s-link>
                </s-stack>
              </>
            ) : (
              <s-banner tone="warning" heading="No payment link available">
                <s-paragraph>
                  The draft order was created, but Shopify didn&apos;t return a
                  payment link. You can find it under Orders &gt; Drafts in your
                  Shopify admin.
                </s-paragraph>
              </s-banner>
            )}
          </s-stack>
        </s-section>
      )}

      <s-section heading="Line item pricing">
        <s-stack direction="block" gap="base">
          {quote.items.map((item) => (
            <s-box
              key={item.id}
              padding="base"
              borderWidth="base"
              borderRadius="base"
            >
              <s-stack direction="block" gap="small-200">
                <s-heading>{item.title}</s-heading>
                {item.variantTitle && <s-text>{item.variantTitle}</s-text>}
                <s-text>Quantity: {item.quantity}</s-text>
                <s-money-field
                  label={`Unit price (${quote.currency})`}
                  value={prices[item.id] ?? ""}
                  min={0}
                  readOnly={!canSend}
                  onInput={(event: Event) =>
                    setPrices((current) => ({
                      ...current,
                      [item.id]: (event.target as HTMLInputElement).value,
                    }))
                  }
                />
                <s-text>
                  Subtotal:{" "}
                  {formatMoney(
                    (() => {
                      const minor = previewMinor(
                        prices[item.id] ?? "",
                        quote.currency,
                      );
                      return minor === null ? null : minor * item.quantity;
                    })(),
                    quote.currency,
                  )}
                </s-text>
              </s-stack>
            </s-box>
          ))}

          <s-divider />

          <s-stack direction="inline" gap="base">
            <s-heading>Total</s-heading>
            <s-heading>
              {formatMoney(runningTotalMinor, quote.currency)}
            </s-heading>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Quote details">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200">
            <s-text>Status</s-text>
            <s-badge tone={statusTone(quote.status)}>{quote.status}</s-badge>
          </s-stack>
          <s-paragraph>
            <s-text>Customer: </s-text>
            {quote.customerName}
          </s-paragraph>
          <s-paragraph>
            <s-text>Email: </s-text>
            {quote.customerEmail}
          </s-paragraph>
          <s-paragraph>
            <s-text>Created: </s-text>
            {quote.createdAt}
          </s-paragraph>
          <s-paragraph>
            <s-text>Saved total: </s-text>
            {formatMoney(quote.quotedTotalMinor, quote.currency)}
          </s-paragraph>
          {quote.draftOrderId && (
            <s-paragraph>
              <s-text>Draft order: </s-text>
              {quote.draftOrderId.split("/").pop()}
            </s-paragraph>
          )}
        </s-stack>
      </s-section>

      {quote.note && (
        <s-section slot="aside" heading="Note">
          <s-paragraph>{quote.note}</s-paragraph>
        </s-section>
      )}
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
