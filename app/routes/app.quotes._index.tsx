import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { SAMPLE_QUOTE_ENABLED, authenticate } from "../shopify.server";
import {
  minorToNumber,
  formatDate,
  formatMoney,
  statusTone,
} from "../quotes";
import { FALLBACK_CURRENCY, shopCurrency } from "../shop-currency.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const quotes = await prisma.quote.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { items: true } } },
  });

  // Counted from the rows already fetched rather than a second query — the
  // list is the same shop-scoped set, so this cannot drift from what renders.
  const requestedCount = quotes.filter(
    (quote) => quote.status === "REQUESTED",
  ).length;

  // Dates are formatted here so the list renders identically on server and
  // client regardless of the viewer's locale.
  return {
    requestedCount,
    // The flag is resolved on the server and passed down, because the seed is
    // gated in the action too and the two must agree — a button the action
    // would refuse should never render.
    sampleQuoteEnabled: SAMPLE_QUOTE_ENABLED,
    quotes: quotes.map((quote) => ({
      id: quote.id,
      customerName: quote.customerName,
      company: quote.company,
      itemCount: quote._count.items,
      // BigInt column; bigint cannot ride along in the loader payload.
      quotedTotalMinor: minorToNumber(quote.quotedTotalMinor),
      currency: quote.currency,
      status: quote.status,
      createdAt: formatDate(quote.createdAt),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();
  if (formData.get("intent") !== "sample") {
    return { error: "Unsupported action" };
  }

  // Checked server-side rather than trusting the hidden button: the buttons are
  // the only caller today, but a POST to this route is reachable without them.
  // Refused before the Admin API call, so a blocked request costs nothing.
  if (!SAMPLE_QUOTE_ENABLED) {
    return { error: "Sample quotes are only available in development." };
  }

  // Quote prices are entered, displayed and invoiced in the shop's own
  // currency, so the quote has to record which one that is.
  const currency =
    (await shopCurrency(session.shop, { admin })) ?? FALLBACK_CURRENCY;

  // Fabricated seed data, for walking the pricing and ordering flow in
  // development without waiting on a real storefront request.
  const quote = await prisma.quote.create({
    data: {
      shop: session.shop,
      customerName: "Acme Coffee Roasters",
      // A real TLD, not .example: draftOrderCreate rejects reserved domains
      // with "Email contains an invalid domain name".
      customerEmail: "buyer@acmecoffee.com",
      company: "Acme Coffee Roasters LLC",
      status: "REQUESTED",
      currency,
      note: "Sample quote created from the dashboard for development.",
      items: {
        create: [
          { title: "Ethiopia Yirgacheffe 1kg", quantity: 50 },
          { title: "Colombia Supremo 1kg", quantity: 30 },
        ],
      },
    },
  });

  return { createdId: quote.id };
};

export default function QuotesIndex() {
  const { quotes, requestedCount, sampleQuoteEnabled } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  const isBusy = fetcher.state !== "idle";
  const createdId = fetcher.data && "createdId" in fetcher.data
    ? fetcher.data.createdId
    : undefined;
  const actionError =
    fetcher.data && "error" in fetcher.data ? fetcher.data.error : undefined;

  useEffect(() => {
    if (createdId) {
      shopify.toast.show("Sample quote created");
    }
  }, [createdId, shopify]);

  const createSample = () =>
    fetcher.submit({ intent: "sample" }, { method: "POST" });

  return (
    <s-page heading="Quotes">
      {sampleQuoteEnabled && (
        <s-button
          slot="primary-action"
          onClick={createSample}
          {...(isBusy ? { loading: true } : {})}
        >
          Create sample quote
        </s-button>
      )}

      {actionError && (
        <s-banner tone="critical" heading="Something went wrong">
          <s-paragraph>{actionError}</s-paragraph>
        </s-banner>
      )}

      {requestedCount > 0 && (
        <s-banner
          tone="info"
          heading={`${requestedCount} new ${
            requestedCount === 1 ? "request" : "requests"
          }`}
        >
          <s-paragraph>
            {requestedCount === 1 ? "There is" : "There are"} {requestedCount}{" "}
            quote {requestedCount === 1 ? "request" : "requests"} still waiting
            to be priced. Open the {requestedCount === 1 ? "row" : "rows"}{" "}
            marked <s-badge tone="info">New</s-badge> below to enter unit
            prices.
          </s-paragraph>
        </s-banner>
      )}

      <s-section>
        {quotes.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-heading>No quotes yet</s-heading>
            {/*
              The second sentence offers the sample button, so it goes when the
              button does — otherwise production reads as an invitation to click
              something that is not there.
            */}
            <s-paragraph>
              Quote requests from your storefront will appear here.
              {sampleQuoteEnabled
                ? " You can also create a sample quote to walk through the pricing and ordering flow."
                : ""}
            </s-paragraph>
            {sampleQuoteEnabled && (
              <s-stack direction="inline">
                <s-button
                  variant="primary"
                  onClick={createSample}
                  {...(isBusy ? { loading: true } : {})}
                >
                  Create sample quote
                </s-button>
              </s-stack>
            )}
          </s-stack>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Customer</s-table-header>
              <s-table-header listSlot="secondary">Company</s-table-header>
              <s-table-header format="numeric">Items</s-table-header>
              <s-table-header format="currency">Total</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Created</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {quotes.map((quote) => (
                <s-table-row
                  key={quote.id}
                  clickDelegate={`quote-link-${quote.id}`}
                >
                  <s-table-cell>
                    {/* s-table-row has no tone/highlight prop, so the "new"
                        marker has to live inside a cell. */}
                    <s-stack direction="inline" gap="small-200">
                      <s-link
                        id={`quote-link-${quote.id}`}
                        href={`/app/quotes/${quote.id}`}
                      >
                        {quote.customerName}
                      </s-link>
                      {quote.status === "REQUESTED" && (
                        <s-badge tone="info" color="strong">
                          New
                        </s-badge>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{quote.company ?? "—"}</s-table-cell>
                  <s-table-cell>{quote.itemCount}</s-table-cell>
                  <s-table-cell>
                    {formatMoney(quote.quotedTotalMinor, quote.currency)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(quote.status)}>
                      {quote.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{quote.createdAt}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
