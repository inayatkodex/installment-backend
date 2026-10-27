-- CreateIndex
CREATE INDEX "customer_items_customerId_idx" ON "customer_items"("customerId");

-- CreateIndex
CREATE INDEX "customers_shopId_phone_idx" ON "customers"("shopId", "phone");

-- CreateIndex
CREATE INDEX "fee_records_month_status_idx" ON "fee_records"("month", "status");

-- CreateIndex
CREATE INDEX "payments_paidOn_reversedAt_idx" ON "payments"("paidOn", "reversedAt");

-- CreateIndex
CREATE INDEX "shops_status_idx" ON "shops"("status");

-- CreateIndex
CREATE INDEX "shops_createdAt_idx" ON "shops"("createdAt");
