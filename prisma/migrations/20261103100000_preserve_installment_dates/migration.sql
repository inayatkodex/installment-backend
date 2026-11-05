CREATE TABLE "customer_schedule_date_changes" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "fromInstallmentNo" INTEGER NOT NULL,
  "firstDueDate" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_schedule_date_changes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_purchase_schedule_date_changes" (
  "id" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "fromInstallmentNo" INTEGER NOT NULL,
  "firstDueDate" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_purchase_schedule_date_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_schedule_date_changes_customerId_fromInstallmentNo_key"
  ON "customer_schedule_date_changes"("customerId", "fromInstallmentNo");
CREATE INDEX "customer_schedule_date_changes_customerId_idx"
  ON "customer_schedule_date_changes"("customerId");
CREATE UNIQUE INDEX "customer_purchase_schedule_date_changes_purchaseId_fromInstallmentNo_key"
  ON "customer_purchase_schedule_date_changes"("purchaseId", "fromInstallmentNo");
CREATE INDEX "customer_purchase_schedule_date_changes_purchaseId_idx"
  ON "customer_purchase_schedule_date_changes"("purchaseId");

ALTER TABLE "customer_schedule_date_changes"
  ADD CONSTRAINT "customer_schedule_date_changes_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "customer_purchase_schedule_date_changes"
  ADD CONSTRAINT "customer_purchase_schedule_date_changes_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "customer_purchases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
