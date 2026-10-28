ALTER TABLE "customers"
  ADD COLUMN "initialMonthlyPayment" INTEGER,
  ADD COLUMN "monthlyPayment" INTEGER;

UPDATE "customers" AS c
SET "initialMonthlyPayment" = CASE
  WHEN COALESCE(
    (SELECT SUM(i."price") FROM "customer_items" AS i WHERE i."customerId" = c."id"),
    0
  ) <= c."downPayment" THEN 0
  ELSE CEIL(
    (
      COALESCE(
        (SELECT SUM(i."price") FROM "customer_items" AS i WHERE i."customerId" = c."id"),
        0
      ) - c."downPayment"
    )::numeric / c."months"
  )::integer
END;

UPDATE "customers" SET "monthlyPayment" = "initialMonthlyPayment";
ALTER TABLE "customers" ALTER COLUMN "initialMonthlyPayment" SET NOT NULL;
ALTER TABLE "customers" ALTER COLUMN "monthlyPayment" SET NOT NULL;
ALTER TABLE "customers" DROP COLUMN "months";

CREATE TABLE "customer_rate_changes" (
  "id" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "fromInstallmentNo" INTEGER NOT NULL,
  "monthlyPayment" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_rate_changes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_rate_changes_customerId_fromInstallmentNo_key"
  ON "customer_rate_changes"("customerId", "fromInstallmentNo");
CREATE INDEX "customer_rate_changes_customerId_idx"
  ON "customer_rate_changes"("customerId");
ALTER TABLE "customer_rate_changes"
  ADD CONSTRAINT "customer_rate_changes_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
