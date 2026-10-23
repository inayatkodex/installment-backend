-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('pending', 'active', 'inactive', 'archived');

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
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_shopNo_key" ON "shops"("shopNo");

-- CreateIndex
CREATE UNIQUE INDEX "shops_mobile_key" ON "shops"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "admins_email_key" ON "admins"("email");
