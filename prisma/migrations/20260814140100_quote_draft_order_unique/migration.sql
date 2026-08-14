-- CreateIndex
CREATE UNIQUE INDEX "Quote_draftOrderId_key" ON "Quote"("draftOrderId");

-- CreateIndex
CREATE INDEX "Quote_shop_customerEmail_createdAt_idx" ON "Quote"("shop", "customerEmail", "createdAt");
