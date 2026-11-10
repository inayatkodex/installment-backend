CREATE TABLE "shop_refresh_tokens" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "tokenVersion" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "sessionExpiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "replacedById" TEXT,
  "refreshRetryUntil" TIMESTAMP(3),
  "deviceName" TEXT,
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shop_refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_refresh_tokens_tokenHash_key"
  ON "shop_refresh_tokens"("tokenHash");
CREATE INDEX "shop_refresh_tokens_shopId_sessionExpiresAt_idx"
  ON "shop_refresh_tokens"("shopId", "sessionExpiresAt");
CREATE INDEX "shop_refresh_tokens_familyId_idx"
  ON "shop_refresh_tokens"("familyId");
CREATE INDEX "shop_refresh_tokens_expiresAt_idx"
  ON "shop_refresh_tokens"("expiresAt");

ALTER TABLE "shop_refresh_tokens"
  ADD CONSTRAINT "shop_refresh_tokens_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_refresh_tokens"
  ADD CONSTRAINT "shop_refresh_tokens_replacedById_fkey"
  FOREIGN KEY ("replacedById") REFERENCES "shop_refresh_tokens"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
