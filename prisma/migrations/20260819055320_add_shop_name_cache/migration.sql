-- AlterTable
ALTER TABLE "ShopSetting" ADD COLUMN     "currencyUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "nameUpdatedAt" TIMESTAMP(3);

-- Existing rows already carry a real "when the currency was last confirmed" in
-- updatedAt, and nothing else had written to the row until now. Carry it over so
-- the split does not silently mark every cached currency as freshly confirmed.
UPDATE "ShopSetting" SET "currencyUpdatedAt" = "updatedAt";
