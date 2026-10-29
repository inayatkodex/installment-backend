CREATE TABLE "customer_purchase_rate_changes" (
  "id" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "fromInstallmentNo" INTEGER NOT NULL,
  "monthlyPayment" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_purchase_rate_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_purchase_rate_changes_purchaseId_fromInstallmentNo_key"
  ON "customer_purchase_rate_changes"("purchaseId", "fromInstallmentNo");
CREATE INDEX "customer_purchase_rate_changes_purchaseId_idx"
  ON "customer_purchase_rate_changes"("purchaseId");

ALTER TABLE "customer_purchase_rate_changes"
  ADD CONSTRAINT "customer_purchase_rate_changes_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "customer_purchases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
