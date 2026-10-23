-- CreateEnum
CREATE TYPE "FeeStatus" AS ENUM ('paid', 'unpaid');

-- AlterTable
ALTER TABLE "shops" ADD COLUMN     "monthlyFee" INTEGER NOT NULL DEFAULT 2500,
ADD COLUMN     "statusNote" TEXT;

-- CreateTable
CREATE TABLE "fee_records" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "FeeStatus" NOT NULL DEFAULT 'unpaid',
    "paidOn" TIMESTAMP(3),
    "method" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fee_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_records_shopId_month_key" ON "fee_records"("shopId", "month");

-- AddForeignKey
ALTER TABLE "fee_records" ADD CONSTRAINT "fee_records_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
