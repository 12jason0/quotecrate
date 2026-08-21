/**
 * Shared helpers for the quote dashboard.
 *
 * Money is stored as integer **minor units of its own currency** — won for KRW,
 * cents for USD, fils for BHD — and is only turned into a major-unit string at
 * the display/input boundary.
 *
 * The scale is never assumed. Everything derives from `currencyDecimals()`,
 * which reads CLDR through Intl, so a zero-decimal currency is not inflated
 * 100x (which used to overflow INT32 on large KRW quotes) and a three-decimal
 * currency does not lose its third decimal (which used to silently change the
 * amount a buyer was invoiced).
 */

export const QUOTE_STATUSES = [
  "REQUESTED",
  "QUOTED",
  "ACCEPTED",
  "DECLINED",
  "CONVERTED",
  "EXPIRED",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

type BadgeTone =
  | "neutral"
  | "info"
  | "success"
  | "caution"
  | "warning"
  | "critical";

const STATUS_TONES: Record<string, BadgeTone> = {
  REQUESTED: "info",
  QUOTED: "caution",
  ACCEPTED: "success",
  DECLINED: "critical",
  CONVERTED: "success",
  EXPIRED: "neutral",
};

export function statusTone(status: string): BadgeTone {
  return STATUS_TONES[status] ?? "neutral";
}

/**
 * The status in the merchant's own words.
 *
 * The stored values are the state machine's names. "REQUESTED" is a row state;
 * what a merchant has is a *new* request. Showing the raw enum leaks our
 * vocabulary into their dashboard and reads as shouting.
 *
 * Kept beside STATUS_TONES so a status can never pick up a colour without also
 * picking up a label, and used by both the list and the detail page so one quote
 * is never called two different things on two screens.
 */
const STATUS_LABELS: Record<string, string> = {
  REQUESTED: "New",
  QUOTED: "Sent",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  CONVERTED: "Converted",
  EXPIRED: "Expired",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

// A fixed locale keeps server and client output identical, so formatted values
// never trigger a hydration mismatch.
const MONEY_LOCALE = "en-US";

/**
 * How many decimal places a currency is written with: 0 for KRW/JPY, 2 for
 * USD/GBP, 3 for BHD. Read from Intl (CLDR) rather than a hand-kept table, so
 * every currency Shopify supports is covered without maintenance.
 */
const decimalsByCurrency = new Map<string, number>();

export function currencyDecimals(currency: string): number {
  const cached = decimalsByCurrency.get(currency);
  if (cached !== undefined) return cached;

  let decimals: number;
  try {
    // Unknown/invalid codes throw here, and older ICU builds can leave the
    // field unset — either way fall back to the 2-decimal majority rather than
    // breaking in the middle of rendering a quote.
    decimals =
      new Intl.NumberFormat(MONEY_LOCALE, {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    decimals = 2;
  }

  decimalsByCurrency.set(currency, decimals);
  return decimals;
}

/**
 * 10^decimals — what one major unit is worth in minor units. 1 for KRW/JPY,
 * 100 for USD, 1000 for BHD. This is the single scale factor the whole app
 * uses; nothing multiplies or divides by a literal 100 any more.
 */
export function minorUnitFactor(currency: string): number {
  return 10 ** currencyDecimals(currency);
}

/**
 * Ceiling on a single line's unit price, in minor units.
 *
 * A line contributes `unitPrice * quantity` to the total, and the storefront
 * caps a quantity at MAX_LINE_QUANTITY, so holding the unit price below this
 * keeps every line — and therefore any realistic total — inside the exact
 * integer range of a JS number. Without it a mistyped price could be stored and
 * then throw on every later read, taking the whole quote list down with it.
 */
export const MAX_LINE_QUANTITY = 1_000_000;
export const MAX_UNIT_PRICE_MINOR = Math.floor(
  Number.MAX_SAFE_INTEGER / MAX_LINE_QUANTITY,
);

/** Why a typed price was rejected, so the caller can say which it was. */
export class PriceInputError extends Error {
  constructor(
    readonly reason: "invalid" | "too-large",
    message: string,
  ) {
    super(message);
    this.name = "PriceInputError";
  }
}

/**
 * The largest amount that survives the bigint → number crossing intact.
 * Number holds integers exactly up to 2^53-1.
 */
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Bring a money column back across the bigint boundary.
 *
 * The columns are BigInt so a zero-decimal currency cannot overflow INT32, but
 * bigint cannot be JSON-serialised to a loader's client payload and throws the
 * moment it meets a number in arithmetic. So every read converts here, once,
 * and the rest of the app keeps working in plain numbers.
 *
 * Throws rather than silently rounding: a money value that does not fit is a
 * wrong number on an invoice, which is worse than a visible failure.
 */
export function minorToNumber(
  minor: bigint | number | null | undefined,
): number | null {
  if (minor === null || minor === undefined) return null;
  if (typeof minor === "number") return minor;

  if (minor > MAX_SAFE_MINOR || minor < -MAX_SAFE_MINOR) {
    throw new Error(
      `Money value ${minor} exceeds the safe integer range and cannot be displayed accurately.`,
    );
  }

  return Number(minor);
}

export function formatMoney(
  minor: number | null | undefined,
  currency: string,
): string {
  if (minor === null || minor === undefined) return "—";

  return new Intl.NumberFormat(MONEY_LOCALE, {
    style: "currency",
    currency,
  }).format(minor / minorUnitFactor(currency));
}

/**
 * Ceiling on one message in a quote's conversation.
 *
 * Lives here rather than in quote-thread.server.ts because both the merchant's
 * textarea and the buyer's reply box render it as a `maxLength`, and the
 * merchant's page is a React component: importing it from a `.server` module
 * pulled that module into the client bundle and failed the production build
 * with "Server-only module referenced by client". React Router only strips
 * server code from `loader`, `action`, `middleware` and `headers`, so anything
 * a component touches has to come from a module with no server dependencies —
 * which is exactly what this file is.
 *
 * The same 2000 characters the storefront request endpoint caps the buyer's
 * opening note at (LIMITS.note in apps.quotecrate.quote-request.tsx), so every
 * free-text field on a quote holds the same amount.
 */
export const MESSAGE_MAX_LENGTH = 2000;

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(MONEY_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

/**
 * Date *and* time, for the quote conversation.
 *
 * A thread is read as a sequence — "they answered this two hours after I asked"
 * — and a date alone collapses a whole day of back-and-forth into one label
 * repeated on every message. Rendered in UTC and said so, because the server has
 * no idea what timezone either party is in and a bare time that is silently
 * three hours off is worse than an explicit one that is honest.
 */
export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat(MONEY_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

/**
 * A plain decimal amount. Deliberately strict: no exponent form, no hex, no
 * sign, no separators — `Number()` would have accepted "1e3" and "0x1A" and
 * turned a typo into a silently different price.
 */
const PRICE_PATTERN = /^(\d+)(?:\.(\d*))?$/;

/**
 * Parse a major-unit price string into integer minor units of `currency`.
 *
 * Returns null for blank input, and throws PriceInputError for anything
 * unparseable or too large, so a typo can never silently become a zero-priced
 * line or a value that breaks every later read.
 *
 * The scaling walks the digit string instead of multiplying by a power of ten,
 * because binary floating point cannot hold most decimal fractions: the old
 * `Math.round(1.005 * 100)` produced 100, not 101, because 1.005 * 100 is
 * 100.49999999999999. Shifting the decimal point through the characters is
 * exact for every input this accepts.
 */
export function minorFromInput(
  value: string,
  currency: string,
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = PRICE_PATTERN.exec(trimmed);
  if (!match) {
    throw new PriceInputError("invalid", `Invalid price: ${value}`);
  }

  const decimals = currencyDecimals(currency);
  const whole = match[1];
  const fraction = match[2] ?? "";

  // Keep exactly `decimals` fractional digits, padding when the merchant typed
  // fewer ("12.5" in USD is 1250, not 125).
  const kept = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const scaled = Number(whole + kept);

  // Round half up on the first digit that does not fit, rather than truncating
  // it away: in USD "1.005" is 101 minor units, not 100.
  const firstDropped = fraction.charCodeAt(decimals) - 48;
  const minor = firstDropped >= 5 ? scaled + 1 : scaled;

  if (!Number.isSafeInteger(minor) || minor > MAX_UNIT_PRICE_MINOR) {
    throw new PriceInputError("too-large", `Price out of range: ${value}`);
  }

  return minor;
}

/**
 * Convert stored minor units back into the major-unit string an input expects,
 * written with the currency's own precision — a KRW price shows as "10000", a
 * USD one as "10000.00", a BHD one as "10000.000".
 */
export function inputFromMinor(
  minor: number | null | undefined,
  currency: string,
): string {
  if (minor === null || minor === undefined) return "";

  return (minor / minorUnitFactor(currency)).toFixed(
    currencyDecimals(currency),
  );
}

/**
 * The store's name as a buyer should see it.
 *
 * `name` is the shop's real, merchant-facing name, read and cached by
 * shop-profile.server.ts. It is optional because the buyer-facing pages have to
 * render whether or not that lookup has ever succeeded, so a missing name falls
 * back to the myshopify subdomain — "acme-coffee" for acme-coffee.myshopify.com.
 * That fallback is a last resort, not the normal path: it is the shop handle,
 * and a buyer reading it has no reason to recognise it.
 *
 * Lives here rather than in a route because both the buyer's quote page and the
 * "your quote is ready" email name the store, and they must name it the same
 * way.
 */
export function storeName(shop: string, name?: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;

  return shop.replace(/\.myshopify\.com$/i, "") || shop;
}
