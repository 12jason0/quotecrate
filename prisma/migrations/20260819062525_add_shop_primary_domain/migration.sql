-- Rename rather than drop-and-add: `nameUpdatedAt` already holds a real "when
-- the cached shop profile was last confirmed" for every installed shop, and the
-- column now covers the primary domain alongside the name. Prisma's generated
-- migration for a rename is DROP + ADD, which would silently reset every shop's
-- cache freshness to null and force a live Admin call on the next buyer page.
ALTER TABLE "ShopSetting" RENAME COLUMN "nameUpdatedAt" TO "profileUpdatedAt";

-- New, and null until the first profile read fills it in.
ALTER TABLE "ShopSetting" ADD COLUMN "primaryDomainUrl" TEXT;
