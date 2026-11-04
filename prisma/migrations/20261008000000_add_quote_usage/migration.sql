-- CreateTable
CREATE TABLE "QuoteUsage" (
    "shop" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "QuoteUsage_pkey" PRIMARY KEY ("shop","period")
);

