/*
  Warnings:

  - You are about to drop the column `sellerNote` on the `Quote` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "QuoteMessageAuthor" AS ENUM ('CUSTOMER', 'MERCHANT');

-- AlterTable
ALTER TABLE "Quote" DROP COLUMN "sellerNote";

-- CreateTable
CREATE TABLE "QuoteMessage" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "author" "QuoteMessageAuthor" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteMessage_quoteId_createdAt_idx" ON "QuoteMessage"("quoteId", "createdAt");

-- AddForeignKey
ALTER TABLE "QuoteMessage" ADD CONSTRAINT "QuoteMessage_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
