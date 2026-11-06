ALTER TABLE "shops"
  ALTER COLUMN "monthlyFee" SET DEFAULT 0;

ALTER TABLE "fee_records"
  ADD COLUMN "amount" INTEGER NOT NULL DEFAULT 0;

UPDATE "fee_records" fr
SET "amount" = s."monthlyFee"
FROM "shops" s
WHERE fr."shopId" = s."id";

CREATE TABLE "shop_fee_rates" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "amount" INTEGER NOT NULL,
  "effectiveFromMonth" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shop_fee_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_fee_rates_shopId_effectiveFromMonth_key"
  ON "shop_fee_rates"("shopId", "effectiveFromMonth");
CREATE INDEX "shop_fee_rates_effectiveFromMonth_idx"
  ON "shop_fee_rates"("effectiveFromMonth");

ALTER TABLE "shop_fee_rates"
  ADD CONSTRAINT "shop_fee_rates_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "shop_fee_rates" ("id", "shopId", "amount", "effectiveFromMonth")
SELECT
  gen_random_uuid()::text,
  "id",
  "monthlyFee",
  to_char("createdAt" AT TIME ZONE 'Asia/Karachi', 'YYYY-MM')
FROM "shops"
WHERE "monthlyFee" > 0;
