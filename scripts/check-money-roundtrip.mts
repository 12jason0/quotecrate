/**
 * Money round-trip check across the three currency shapes.
 *
 * Run with: npm run check:money
 *
 * These are pure functions, so this needs no database, no Shopify session and
 * no dev server. It exists because the bugs it guards against were both silent:
 * a zero-decimal currency was inflated 100x until it overflowed an INT column,
 * and a three-decimal currency lost its third decimal so the buyer was invoiced
 * an amount the merchant never typed. Neither showed up as an error — only as a
 * wrong number.
 *
 * Every case walks the full path a real price takes:
 *   typed string -> minorFromInput -> stored integer
 *                -> inputFromMinor -> what the merchant sees back in the field
 *                -> formatMoney    -> what is displayed
 *                -> draftAmount    -> the Decimal string sent to Shopify
 */

import {
  currencyDecimals,
  formatMoney,
  inputFromMinor,
  minorFromInput,
  minorUnitFactor,
  PriceInputError,
} from "../app/quotes";

/**
 * Mirrors `money()` in app/draft-order.server.ts. Duplicated rather than
 * imported because that module pulls in the Shopify server runtime; if the two
 * ever diverge this check is wrong, so keep them in step.
 */
function draftAmount(minor: number, currency: string): string {
  return (minor / minorUnitFactor(currency)).toFixed(currencyDecimals(currency));
}

type Case = {
  currency: string;
  typed: string;
  minor: number;
  redisplayed: string;
  formatted: string;
  amount: string;
};

const CASES: Case[] = [
  // 0-decimal: one minor unit IS one won. No 100x inflation — this is what
  // used to overflow INT32 on large quotes.
  {
    currency: "KRW",
    typed: "10000",
    minor: 10000,
    redisplayed: "10000",
    formatted: "₩10,000",
    amount: "10000",
  },
  // 2-decimal: the ordinary case.
  {
    currency: "USD",
    typed: "12.50",
    minor: 1250,
    redisplayed: "12.50",
    formatted: "$12.50",
    amount: "12.50",
  },
  // 3-decimal: the third decimal must survive. Under the old ×100 model this
  // became 1235 and was invoiced as 12.35.
  {
    currency: "BHD",
    typed: "12.345",
    minor: 12345,
    redisplayed: "12.345",
    formatted: "BHD 12.345",
    amount: "12.345",
  },
];

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}: ${JSON.stringify(actual)}${
      ok ? "" : ` (expected ${JSON.stringify(expected)})`
    }`,
  );
}

console.log("Money round-trip by currency shape\n");

for (const c of CASES) {
  console.log(`${c.currency} (${currencyDecimals(c.currency)} decimals) — typed "${c.typed}"`);

  const minor = minorFromInput(c.typed, c.currency);
  check("stored minor units", minor, c.minor);
  check("back into the input", inputFromMinor(minor, c.currency), c.redisplayed);
  // Intl uses a non-breaking space before some currency codes; normalise it so
  // the comparison is about the number, not the spacing.
  check(
    "displayed",
    formatMoney(minor, c.currency).replace(/ /g, " "),
    c.formatted,
  );
  check("sent to Shopify", draftAmount(minor!, c.currency), c.amount);
  console.log("");
}

console.log("Line totals stay at a sane magnitude");
{
  // The bug report: 50 × ₩9,000,000 + 30 × ₩5,643,643 = ₩619,309,290.
  // Under ×100 storage this was 61,930,929,000 — 29x past the INT32 ceiling.
  const a = minorFromInput("9000000", "KRW")! * 50;
  const b = minorFromInput("5643643", "KRW")! * 30;
  check("KRW total in minor units", a + b, 619_309_290);
  check("under the old INT32 ceiling", a + b < 2_147_483_647, true);
  console.log("");
}

console.log("Decimal rounding is exact, not floating point");
{
  // Math.round(1.005 * 100) is 100, because 1.005 * 100 is 100.49999999999999.
  check("USD 1.005", minorFromInput("1.005", "USD"), 101);
  check("USD 0.145", minorFromInput("0.145", "USD"), 15);
  check("USD 12.5 pads", minorFromInput("12.5", "USD"), 1250);
  check("KRW 10000.6 rounds", minorFromInput("10000.6", "KRW"), 10001);
  console.log("");
}

console.log("Bad input is refused rather than silently reinterpreted");
{
  const rejects = (value: string, reason: "invalid" | "too-large") => {
    try {
      minorFromInput(value, "USD");
      check(`rejects ${JSON.stringify(value)}`, "accepted", `throws ${reason}`);
    } catch (error) {
      check(
        `rejects ${JSON.stringify(value)}`,
        error instanceof PriceInputError ? error.reason : "other error",
        reason,
      );
    }
  };

  rejects("1e3", "invalid");
  rejects("0x1A", "invalid");
  rejects("-5", "invalid");
  rejects("abc", "invalid");
  // Large enough that unit price × max quantity would leave the exact integer
  // range; storing it would break every later read of the quote list.
  rejects("99999999999999", "too-large");

  check("blank is null, not an error", minorFromInput("   ", "USD"), null);
  console.log("");
}

if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}

console.log("All money round-trip checks passed.");
