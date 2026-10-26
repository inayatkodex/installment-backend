-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('pending', 'active', 'inactive', 'archived');

-- CreateEnum
CREATE TYPE "FeeStatus" AS ENUM ('paid', 'unpaid');

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "shopNo" SERIAL NOT NULL,
    "shopName" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "email" TEXT,
    "cnic" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "ShopStatus" NOT NULL DEFAULT 'pending',
    "statusNote" TEXT,
    "monthlyFee" INTEGER NOT NULL DEFAULT 2500,
    "customerSeq" INTEGER NOT NULL DEFAULT 0,
    "profilePic" TEXT,
    "docPhoto" TEXT,
    "docCnicFront" TEXT,
    "docCnicBack" TEXT,
    "docShopDocument" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

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

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerNo" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "fatherName" TEXT,
    "phone" TEXT NOT NULL,
    "cnic" TEXT,
    "address" TEXT,
    "photo" TEXT,
    "docCnicFront" TEXT,
    "docCnicBack" TEXT,
    "docOther" TEXT,
    "downPayment" INTEGER NOT NULL,
    "months" INTEGER NOT NULL,
    "firstDueDate" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_items" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "photo" TEXT,
    "boughtOn" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'Cash',
    "note" TEXT,
    "paidOn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopNo_key" ON "shops"("shopNo");

-- CreateIndex
CREATE UNIQUE INDEX "shops_mobile_key" ON "shops"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "fee_records_shopId_month_key" ON "fee_records"("shopId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");

-- CreateIndex
CREATE INDEX "customers_shopId_deletedAt_idx" ON "customers"("shopId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "customers_shopId_customerNo_key" ON "customers"("shopId", "customerNo");

-- CreateIndex
CREATE INDEX "payments_customerId_idx" ON "payments"("customerId");

-- AddForeignKey
ALTER TABLE "fee_records" ADD CONSTRAINT "fee_records_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_items" ADD CONSTRAINT "customer_items_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
