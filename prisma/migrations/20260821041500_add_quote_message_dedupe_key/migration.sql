-- AlterTable
ALTER TABLE "QuoteMessage" ADD COLUMN     "dedupeKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "QuoteMessage_quoteId_dedupeKey_key" ON "QuoteMessage"("quoteId", "dedupeKey");

