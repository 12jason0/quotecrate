/**
 * The conversation attached to a quote.
 *
 * A quote is a negotiation, so both pages that show one — the merchant's detail
 * page and the buyer's public page — render the same back-and-forth, and both
 * can append to it. Everything they need in common lives here: the length cap,
 * the render-time merge that puts the buyer's original request note at the top,
 * and the append itself.
 *
 * The append is the part that has to be right. Two sides can write at the same
 * moment, the buyer's reply form works without JavaScript (so nothing on the
 * client stops a double submit), and every message that lands sends an email to
 * the other side. So an append that runs twice is not a cosmetic duplicate — it
 * is two emails for one sentence.
 */

import { createHash } from "node:crypto";

import { Prisma, type QuoteMessageAuthor } from "@prisma/client";

import prisma from "./db.server";
// Deliberately not re-exported from here: the pages that render it as a
// maxLength are client components, and re-exporting would put this module back
// in their import graph — the very thing that broke the build.
import { MESSAGE_MAX_LENGTH } from "./quotes";

/**
 * How long an identical message from the same side counts as a resend of the
 * one already stored rather than a new one.
 *
 * Aimed at the double submit: a buyer double-clicking Send, a page reloaded on a
 * POST, or two admin tabs. Long enough to cover a slow round trip and a human
 * pressing the button again, short enough that someone genuinely repeating
 * themselves ("bump — any update?") an hour later still gets through.
 */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

/**
 * How many messages one side may add to a quote inside RATE_WINDOW_MS.
 *
 * A backstop against a stuck submit button or a script, not a limit a real
 * conversation runs into: a person writing ten messages in five minutes is
 * already unusual. Counted per author so a flood from one side can never
 * silence the other.
 */
export const MAX_MESSAGES_PER_WINDOW = 10;

/** The window MAX_MESSAGES_PER_WINDOW is counted over. */
export const RATE_WINDOW_MS = 5 * 60 * 1000;

/**
 * A message as the pages render it.
 *
 * Deliberately not the Prisma row: the first entry in every thread is the
 * buyer's request note, which is not a QuoteMessage at all (see `buildThread`).
 */
export type ThreadMessage = {
  author: QuoteMessageAuthor;
  body: string;
  createdAt: Date;
  /**
   * True for the synthesised opening note. The pages do not label it
   * differently, but the previews and any future "edit" affordance need to know
   * that there is no row behind it.
   */
  isRequestNote: boolean;
};

/**
 * The whole conversation, oldest first.
 *
 * The buyer's request note is prepended here rather than copied into the
 * QuoteMessage table when the quote is created. It already lives on the quote,
 * where the merchant notification email and the Shopify draft order read it
 * from; duplicating it would give one sentence two homes that can drift apart,
 * and would have needed a backfill for every quote raised before this existed.
 * Merging at render time costs nothing and cannot go stale.
 *
 * It is timestamped with the quote's own `createdAt`, because that is when the
 * buyer wrote it — it was the request.
 */
export function buildThread(
  quote: { note: string | null; createdAt: Date },
  messages: { author: QuoteMessageAuthor; body: string; createdAt: Date }[],
): ThreadMessage[] {
  const thread: ThreadMessage[] = [];

  const note = quote.note?.trim();
  if (note) {
    thread.push({
      author: "CUSTOMER",
      body: note,
      createdAt: quote.createdAt,
      isRequestNote: true,
    });
  }

  for (const message of messages) {
    thread.push({
      author: message.author,
      body: message.body,
      createdAt: message.createdAt,
      isRequestNote: false,
    });
  }

  // Sorted rather than assumed: the request note is first by construction, but
  // the caller decides how it queried the rows and a thread rendered out of
  // order is worse than a slow one.
  return thread.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Read one submitted message body: not-a-string is empty, and the cap is hard. */
export function readMessageBody(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MESSAGE_MAX_LENGTH);
}

/**
 * What an append did.
 *
 * `duplicate` and `rate-limited` both mean "nothing was written", and both are
 * the reason the caller must not send a notification email: exactly one message
 * stored is exactly one email sent.
 */
export type AppendResult =
  | { status: "created"; message: { id: string; body: string; createdAt: Date } }
  | { status: "empty" }
  | { status: "duplicate" }
  | { status: "rate-limited" }
  | { status: "not-found" };

/**
 * The value the `(quoteId, dedupeKey)` unique index refuses a second time.
 *
 * Author, a digest of the body, and the time bucket the write falls in. Hashed
 * rather than stored raw so the key stays short and indexable whatever someone
 * pastes into the box, and bucketed so "the same message again next week" is a
 * genuinely new message rather than a silent no-op forever.
 *
 * Bucketing means two identical submissions either side of a boundary both get
 * through. That gap is covered by the read below, which uses a real rolling
 * window; between them the only escape is a true simultaneous race that also
 * straddles a boundary, which costs one duplicate message rather than anything
 * that matters.
 */
function dedupeKey(author: QuoteMessageAuthor, body: string, now: number): string {
  const bucket = Math.floor(now / DUPLICATE_WINDOW_MS);
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 32);

  return `${author}:${bucket}:${digest}`;
}

/**
 * Append one message to a quote's thread, once.
 *
 * Deliberately not an interactive transaction holding a row lock. That was the
 * first shape of this function and it serialised every append to a quote across
 * processes — correct, but it parks a pooled connection for the duration, and a
 * handful of concurrent replies exhausted the pool and failed outright. The
 * unique index does the same job atomically and holds nothing.
 *
 * So there are two layers, and they cover different failures:
 *
 *   1. A read over a real rolling window, which catches the ordinary repeat —
 *      the buyer pressing Send twice a second apart, or reloading the POST.
 *   2. The `(quoteId, dedupeKey)` unique index, which catches the two writes
 *      that genuinely raced and both saw an empty window at step 1.
 *
 * The `shop` filter on the existence check is what stops one shop writing into
 * another shop's quote by guessing an id.
 */
export async function appendMessage({
  quoteId,
  shop,
  author,
  body,
}: {
  quoteId: string;
  shop: string;
  author: QuoteMessageAuthor;
  body: string;
}): Promise<AppendResult> {
  const trimmed = readMessageBody(body);
  if (!trimmed) return { status: "empty" };

  const owned = await prisma.quote.findFirst({
    where: { id: quoteId, shop },
    select: { id: true },
  });

  if (!owned) return { status: "not-found" };

  const now = Date.now();

  const duplicate = await prisma.quoteMessage.findFirst({
    where: {
      quoteId,
      author,
      body: trimmed,
      createdAt: { gte: new Date(now - DUPLICATE_WINDOW_MS) },
    },
    select: { id: true },
  });

  if (duplicate) return { status: "duplicate" };

  // A soft backstop against a stuck button or a script, counted the same way
  // quote-rate-limit.server.ts counts quote requests: a plain query, no lock. A
  // race here can let one extra message past the ceiling, which is the right
  // trade for a limit that exists to stop hundreds.
  const recent = await prisma.quoteMessage.count({
    where: {
      quoteId,
      author,
      createdAt: { gte: new Date(now - RATE_WINDOW_MS) },
    },
  });

  if (recent >= MAX_MESSAGES_PER_WINDOW) {
    console.warn(
      `[quotecrate] Rate limited ${author} messages on quote ${quoteId}: ${recent} in the last ${
        RATE_WINDOW_MS / 60000
      } minutes.`,
    );
    return { status: "rate-limited" };
  }

  try {
    const message = await prisma.quoteMessage.create({
      data: {
        quoteId,
        author,
        body: trimmed,
        dedupeKey: dedupeKey(author, trimmed, now),
      },
      select: { id: true, body: true, createdAt: true },
    });

    return { status: "created", message };
  } catch (error) {
    // P2002 is the unique violation: another request wrote this exact message
    // in this exact bucket a moment ago. That is the race the index exists to
    // decide, and losing it means the message is already on the thread.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return { status: "duplicate" };
    }

    throw error;
  }
}

/** The thread rows for one quote, oldest first. */
export function readMessages(quoteId: string) {
  return prisma.quoteMessage.findMany({
    where: { quoteId },
    orderBy: { createdAt: "asc" },
    select: { id: true, author: true, body: true, createdAt: true },
  });
}
