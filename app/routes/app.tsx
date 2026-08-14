import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import {
  authenticate,
  BILLING_IS_TEST,
  BILLING_REQUIRED,
  STANDARD_PLAN,
} from "../shopify.server";
import { shopCurrency } from "../shop-currency.server";

/**
 * `BillingError` reports every failure as "Error while billing the store" and hides
 * the real cause (appSubscriptionCreate userErrors, or top-level GraphQL errors) in
 * its `errorData` field. Surface it so billing failures are diagnosable from the logs.
 */
function logBillingError(error: unknown) {
  const errorData = (error as { errorData?: unknown })?.errorData;
  if (errorData === undefined) return;

  /* eslint-disable no-undef, no-console */
  console.error(
    "[QuoteCrate billing] %s: %s\nerrorData: %s",
    (error as Error).name,
    (error as Error).message,
    JSON.stringify(errorData, null, 2),
  );
  /* eslint-enable no-undef, no-console */
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, billing, session } = await authenticate.admin(request);

  // Shops without an active subscription are sent to Shopify's approval page.
  // `billing.request` throws the redirect, so subscribed shops fall straight through.
  if (BILLING_REQUIRED) {
    try {
      await billing.require({
        plans: [STANDARD_PLAN],
        isTest: BILLING_IS_TEST,
        onFailure: async () =>
          billing.request({ plan: STANDARD_PLAN, isTest: BILLING_IS_TEST }),
      });
    } catch (error) {
      // The approval redirect is thrown, not returned — never swallow it.
      if (error instanceof Response) throw error;
      logBillingError(error);
      throw error;
    }
  }

  // Every admin page in the app renders inside this route, so this is the one
  // place an authenticated admin context is guaranteed — including on the
  // merchant's first load right after install. Refreshing the shop's currency
  // here (a no-op while the cached value is fresh) is what lets the storefront
  // quote-request endpoint, which has no such context, read the currency from
  // our own database instead of a live call that can fail.
  await shopCurrency(session.shop, { admin });

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
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
