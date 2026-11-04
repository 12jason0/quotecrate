/**
 * Free-plan quote allowance check.
 *
 * Run with: DATABASE_URL=postgresql://...@localhost/... npm run check:usage
 *
 * Needs a throwaway Postgres with the migrations applied
 * (`npx prisma migrate deploy`). It deletes QuoteUsage and Quote rows for its
 * own test shops, so it refuses any DATABASE_URL that is not on localhost.
 *
 * The Shopify subscription lookup is injected, so no store or network is needed.
 */

import assert from "node:assert/strict";

const url = new URL(process.env.DATABASE_URL ?? "postgresql://none");
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error(
    `Refusing to run against ${url.hostname}; use a local database.`,
  );
}

process.env.SHOPIFY_API_KEY ??= "test";
process.env.SHOPIFY_API_SECRET ??= "test";
process.env.SHOPIFY_APP_URL ??= "https://example.com";

const { default: prisma } = await import("../app/db.server");
const {
  FREE_QUOTE_LIMIT,
  createQuoteWithinPlan,
  currentPeriod,
  getQuoteUsage,
  hasStandard,
} = await import("../app/quote-usage.server");

const SHOP = "usage-check.myshopify.com";
const OCT = new Date("2026-10-31T23:59:59Z");
const NOV = new Date("2026-11-01T00:00:00Z");

let lookups = 0;
const free = async () => (lookups++, false);
const standard = async () => (lookups++, true);
const failing = async () => (lookups++, null);

const create = (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) =>
  tx.quote.create({
    data: { shop: SHOP, customerName: "Check", customerEmail: "c@example.com" },
  });

async function reset() {
  await prisma.quoteUsage.deleteMany({ where: { shop: SHOP } });
  await prisma.quote.deleteMany({ where: { shop: SHOP } });
  lookups = 0;
}

const quotes = () => prisma.quote.count({ where: { shop: SHOP } });

// Period is the UTC month, whatever the server's own time zone.
assert.equal(currentPeriod(new Date("2026-10-31T23:59:59Z")), "2026-10");
assert.equal(currentPeriod(new Date("2026-11-01T00:00:00Z")), "2026-11");
assert.equal(currentPeriod(new Date("2026-11-01T08:00:00+09:00")), "2026-10");

// Test subscriptions count only where billing.check would count them.
assert.equal(hasStandard([{ name: "Standard", test: true }], false), false);
assert.equal(hasStandard([{ name: "Standard", test: true }], true), true);
assert.equal(hasStandard([{ name: "Standard", test: false }], false), true);
assert.equal(hasStandard([{ name: "Other", test: false }], true), false);

// Free: 1-5 allowed with no Shopify lookup, 6 refused, nothing written for it.
await reset();
for (let i = 1; i <= FREE_QUOTE_LIMIT; i++) {
  assert.ok(
    await createQuoteWithinPlan(SHOP, create, {
      enforce: true,
      lookup: free,
      now: OCT,
    }),
  );
}
assert.equal(lookups, 0, "no subscription lookup below the limit");
assert.equal(
  await createQuoteWithinPlan(SHOP, create, {
    enforce: true,
    lookup: free,
    now: OCT,
  }),
  null,
);
assert.equal(lookups, 1);
assert.equal(await getQuoteUsage(SHOP, OCT), 5);
assert.equal(await quotes(), 5);

// Deleting a quote does not hand the slot back.
await prisma.quote.deleteMany({ where: { shop: SHOP } });
assert.equal(
  await createQuoteWithinPlan(SHOP, create, {
    enforce: true,
    lookup: free,
    now: OCT,
  }),
  null,
);

// Month rollover: November starts at zero with no reset job.
assert.ok(
  await createQuoteWithinPlan(SHOP, create, {
    enforce: true,
    lookup: free,
    now: NOV,
  }),
);
assert.equal(await getQuoteUsage(SHOP, NOV), 1);
assert.equal(await getQuoteUsage(SHOP, OCT), 5);

// Standard: unlimited, usage still recorded.
await reset();
for (let i = 1; i <= 12; i++) {
  assert.ok(
    await createQuoteWithinPlan(SHOP, create, {
      enforce: true,
      lookup: standard,
      now: OCT,
    }),
  );
}
assert.equal(await quotes(), 12);
assert.equal(await getQuoteUsage(SHOP, OCT), 12);
assert.equal(lookups, 7, "looked up only for requests past the Free allowance");

// Lookup failure fails open.
await reset();
for (let i = 1; i <= 7; i++) {
  assert.ok(
    await createQuoteWithinPlan(SHOP, create, {
      enforce: true,
      lookup: failing,
      now: OCT,
    }),
  );
}

// Kill switch: enforce=false never limits and never looks up.
await reset();
for (let i = 1; i <= 8; i++) {
  assert.ok(
    await createQuoteWithinPlan(SHOP, create, {
      enforce: false,
      lookup: free,
      now: OCT,
    }),
  );
}
assert.equal(lookups, 0);

// A failed quote write hands its slot back.
await reset();
await assert.rejects(
  createQuoteWithinPlan(
    SHOP,
    async () => {
      throw new Error("write failed");
    },
    { enforce: true, lookup: free, now: OCT },
  ),
);
assert.equal(await getQuoteUsage(SHOP, OCT), 0);

// Race: 20 concurrent Free requests at the start of a month; exactly 5 land.
await reset();
const results = await Promise.all(
  Array.from({ length: 20 }, () =>
    createQuoteWithinPlan(SHOP, create, {
      enforce: true,
      lookup: free,
      now: OCT,
    }),
  ),
);
assert.equal(results.filter(Boolean).length, FREE_QUOTE_LIMIT);
assert.equal(await quotes(), FREE_QUOTE_LIMIT);
assert.equal(await getQuoteUsage(SHOP, OCT), FREE_QUOTE_LIMIT);

await reset();
await prisma.$disconnect();
console.log("quote usage: all checks passed");
