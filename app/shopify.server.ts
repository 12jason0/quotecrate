import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

export const STANDARD_PLAN = "Standard";

/**
 * Test charges cost the merchant $0 and are only accepted on dev/partner stores.
 * `isTest: true` on a billing check means "also accept test subscriptions", so
 * production only ever passes on a real, paid subscription.
 */
// eslint-disable-next-line no-undef
export const BILLING_IS_TEST = process.env.NODE_ENV !== "production";

/**
 * The "Create sample quote" seed writes a fabricated quote straight into the
 * database so the pricing and ordering flow can be walked through before any
 * real request arrives. On a live shop that is merchant-visible junk, so both
 * the buttons and the action behind them are switched off outside development.
 */
// eslint-disable-next-line no-undef
export const SAMPLE_QUOTE_ENABLED = process.env.NODE_ENV !== "production";

/**
 * The Billing API rejects `appSubscriptionCreate` with "Apps without a public
 * distribution cannot use the Billing API" until the app picks Public distribution
 * in the Dev Dashboard — a choice that can't be undone. Until then the gate has to
 * stay off, or every embedded page load fails.
 *
 * Opt in explicitly (`BILLING_REQUIRED=true`) once distribution is set; defaulting
 * to off keeps development unblocked without silently shipping an unpaid app.
 */
// eslint-disable-next-line no-undef
export const BILLING_REQUIRED = process.env.BILLING_REQUIRED === "true";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [STANDARD_PLAN]: {
      trialDays: 14,
      lineItems: [
        {
          amount: 14.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
