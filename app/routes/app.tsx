import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { shouldUseTestCharge } from "../billing-mode.server";
import {
  authenticate,
  BILLING_REQUIRED,
  STANDARD_PLAN,
} from "../shopify.server";
import { shopCurrency } from "../shop-currency.server";
import { FREE_QUOTE_LIMIT, getQuoteUsage } from "../quote-usage.server";

/**
 * `BillingError` reports every failure as "Error while billing the store" and hides
 * the real cause (appSubscriptionCreate userErrors, or top-level GraphQL errors) in
 * its `errorData` field. Surface it so billing failures are diagnosable from the logs.
 */
function logBillingError(error: unknown) {
  const errorData = (error as { errorData?: unknown })?.errorData;

  /* eslint-disable no-undef, no-console */
  console.error(
    "[QuoteCrate billing] %s: %s\nerrorData: %s",
    (error as Error)?.name,
    (error as Error)?.message ?? String(error),
    JSON.stringify(errorData, null, 2),
  );
  /* eslint-enable no-undef, no-console */
}

/**
 * The `host` parameter Shopify appends to embedded requests: base64 of
 * `admin.shopify.com/store/{store-handle}`, unpadded.
 *
 * Computed rather than only read off the request because the link built from it
 * has to work no matter which request rendered this route. A client-side
 * navigation re-runs this loader as a `.data` fetch whose URL carries none of
 * Shopify's parameters, and a link built from that request would be missing the
 * one thing the library needs to escape the iframe.
 */
function embeddedHost(shop: string): string {
  const handle = shop.replace(/\.myshopify\.com$/i, "");

  return Buffer.from(`admin.shopify.com/store/${handle}`, "utf8")
    .toString("base64")
    .replace(/=+$/, "");
}

/**
 * What the "Upgrade to Standard" form carries to /app/subscribe.
 *
 * `embedded=1` and `host` are not decoration. `billing.request` escapes the
 * admin iframe by way of `redirectOutOfApp`, which picks its strategy from the
 * request: a document request marked `embedded=1` is redirected to
 * /auth/exit-iframe, where App Bridge moves the top window. Without those
 * parameters it takes the plain-redirect branch instead and tries to load
 * Shopify's confirmation page inside the iframe, which the admin refuses to
 * frame.
 *
 * They are fields rather than a query string because the form has to be a GET,
 * and a GET form discards whatever query string its action already carries.
 */
function subscribeFields(request: Request, shop: string) {
  const incoming = new URL(request.url).searchParams;

  return { shop, host: incoming.get("host") || embeddedHost(shop) };
}

/**
 * The shop's plan, for display only. Child routes read it with
 * `useRouteLoaderData("routes/app")`, so one billing check serves every page.
 *
 * Null when BILLING_REQUIRED is off: no limit is enforced then, and the Billing
 * API cannot be used before the app has Public distribution.
 */
export type ShopPlan =
  | { name: "Standard" }
  | {
      name: "Free";
      used: number;
      limit: number;
      // The UTC month the allowance is counted in, e.g. "October".
      month: string;
      upgrade: { shop: string; host: string };
    };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);

  // This only reads which plan the shop is on. It never asks for a charge and
  // it never blocks: a shop with no Standard subscription is on Free.
  //
  // Asking for a charge from here is what once created a billing loop: a
  // merchant who declined on Shopify's confirmation page was returned to the
  // app, this loader ran, and it sent them straight back. Requesting a charge
  // lives only in app/routes/app.subscribe.tsx, behind the merchant's own click.
  //
  // A check that fails is logged and read as Free, so a Billing API outage shows
  // an Upgrade button instead of taking down every admin page.
  //
  // Whether test subscriptions count is the shop's own answer, not this
  // deployment's — see billing-mode.server.ts.
  let plan: ShopPlan | null = null;
  if (BILLING_REQUIRED) {
    let subscriptionId: string | undefined;
    try {
      const isTest = await shouldUseTestCharge(session.shop, admin);
      const { appSubscriptions } = await billing.check({
        plans: [STANDARD_PLAN],
        isTest,
      });

      subscriptionId = appSubscriptions[0]?.id;
    } catch (error) {
      // A thrown Response is the library asking for re-authentication.
      if (error instanceof Response) throw error;
      logBillingError(error);
    }

    plan = subscriptionId
      ? { name: "Standard" }
      : {
          name: "Free",
          used: await getQuoteUsage(session.shop),
          limit: FREE_QUOTE_LIMIT,
          month: new Date().toLocaleString("en-US", {
            month: "long",
            timeZone: "UTC",
          }),
          upgrade: subscribeFields(request, session.shop),
        };
  }

  // Every admin page in the app renders inside this route, so this is the one
  // place an authenticated admin context is guaranteed — including on the
  // merchant's first load right after install. Refreshing the shop's currency
  // here (a no-op while the cached value is fresh) is what lets the storefront
  // quote-request endpoint, which has no such context, read the currency from
  // our own database instead of a live call that can fail.
  await shopCurrency(session.shop, { admin });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", plan };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/quotes">Quotes</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
