ALTER TABLE "shops"
  ADD COLUMN "pendingDeletionAt" TIMESTAMP(3),
  ADD COLUMN "deletionPreviousStatus" "ShopStatus";

CREATE INDEX "shops_pendingDeletionAt_idx"
  ON "shops"("pendingDeletionAt");

ALTER TABLE "customers"
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3);

CREATE INDEX "customers_deletionRequestedAt_idx"
  ON "customers"("deletionRequestedAt");
