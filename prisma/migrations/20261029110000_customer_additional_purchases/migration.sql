CREATE TABLE "customer_purchases" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "initialMonthlyPayment" INTEGER NOT NULL,
  "monthlyPayment" INTEGER NOT NULL,
  "monthlyCollectionTarget" INTEGER,
  "firstDueDate" TEXT,
  "allocationStartInstallmentNo" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_purchases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "customer_purchase_items" (
  "id" TEXT NOT NULL,
  "purchaseId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "price" INTEGER NOT NULL,
  "photo" TEXT,
  "boughtOn" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_purchase_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_purchases_customerId_createdAt_idx"
  ON "customer_purchases"("customerId", "createdAt");
CREATE INDEX "customer_purchase_items_purchaseId_idx"
  ON "customer_purchase_items"("purchaseId");

ALTER TABLE "customer_purchases"
  ADD CONSTRAINT "customer_purchases_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_purchase_items"
  ADD CONSTRAINT "customer_purchase_items_purchaseId_fkey"
  FOREIGN KEY ("purchaseId") REFERENCES "customer_purchases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
