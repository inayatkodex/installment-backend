ALTER TABLE "customers"
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "filesPurgedAt" TIMESTAMP(3);

CREATE INDEX "customers_archivedAt_completedAt_idx"
  ON "customers"("archivedAt", "completedAt");

CREATE TABLE "monthly_report_snapshots" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "monthly_report_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "monthly_report_snapshots_shopId_month_key"
  ON "monthly_report_snapshots"("shopId", "month");
CREATE INDEX "monthly_report_snapshots_month_idx"
  ON "monthly_report_snapshots"("month");
ALTER TABLE "monthly_report_snapshots"
  ADD CONSTRAINT "monthly_report_snapshots_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "customers" c
SET "completedAt" = GREATEST(
  COALESCE((SELECT MAX(p."paidOn") FROM "payments" p
    WHERE p."customerId" = c."id" AND p."reversedAt" IS NULL), c."createdAt"),
  COALESCE((SELECT MAX(cp."createdAt") FROM "customer_purchases" cp
    WHERE cp."customerId" = c."id"), c."createdAt")
)
WHERE c."deletedAt" IS NULL
  AND (
    COALESCE((SELECT SUM(i."price") FROM "customer_items" i
      WHERE i."customerId" = c."id"), 0)
    + COALESCE((SELECT SUM(i."price") FROM "customer_purchase_items" i
      JOIN "customer_purchases" cp ON cp."id" = i."purchaseId"
      WHERE cp."customerId" = c."id"), 0)
    <= c."downPayment"
      + COALESCE((SELECT SUM(cp."downPayment") FROM "customer_purchases" cp
        WHERE cp."customerId" = c."id"), 0)
      + COALESCE((SELECT SUM(p."amount") FROM "payments" p
        WHERE p."customerId" = c."id" AND p."reversedAt" IS NULL), 0)
  );
