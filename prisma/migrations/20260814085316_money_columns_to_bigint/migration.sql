/*
  Warnings:

  - You are about to alter the column `quotedTotalCents` on the `Quote` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `quotedUnitPriceCents` on the `QuoteItem` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Quote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "company" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "note" TEXT,
    "quotedTotalCents" BIGINT,
    "publicToken" TEXT,
    "draftOrderId" TEXT,
    "invoiceUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Quote" ("company", "createdAt", "currency", "customerEmail", "customerName", "draftOrderId", "id", "invoiceUrl", "note", "publicToken", "quotedTotalCents", "shop", "status", "updatedAt") SELECT "company", "createdAt", "currency", "customerEmail", "customerName", "draftOrderId", "id", "invoiceUrl", "note", "publicToken", "quotedTotalCents", "shop", "status", "updatedAt" FROM "Quote";
DROP TABLE "Quote";
ALTER TABLE "new_Quote" RENAME TO "Quote";
CREATE UNIQUE INDEX "Quote_publicToken_key" ON "Quote"("publicToken");
CREATE INDEX "Quote_shop_status_idx" ON "Quote"("shop", "status");
CREATE TABLE "new_QuoteItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL,
    "quotedUnitPriceCents" BIGINT,
    CONSTRAINT "QuoteItem_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_QuoteItem" ("id", "productId", "quantity", "quoteId", "quotedUnitPriceCents", "title", "variantId", "variantTitle") SELECT "id", "productId", "quantity", "quoteId", "quotedUnitPriceCents", "title", "variantId", "variantTitle" FROM "QuoteItem";
DROP TABLE "QuoteItem";
ALTER TABLE "new_QuoteItem" RENAME TO "QuoteItem";
CREATE INDEX "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
