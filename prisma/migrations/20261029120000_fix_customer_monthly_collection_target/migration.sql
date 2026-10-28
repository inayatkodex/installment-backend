ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "monthlyCollectionTarget" INTEGER;

ALTER TABLE "customer_purchases"
  DROP COLUMN IF EXISTS "monthlyCollectionTarget";
