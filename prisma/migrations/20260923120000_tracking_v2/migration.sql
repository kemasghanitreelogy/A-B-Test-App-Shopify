-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'storefront',
ADD COLUMN     "sessionId" TEXT;

-- AlterTable
ALTER TABLE "Conversion" ADD COLUMN     "attributionKind" TEXT NOT NULL DEFAULT 'cart_attr';

-- AlterTable
ALTER TABLE "Experiment" ADD COLUMN     "variantAChecksum" TEXT;

-- CreateTable
CREATE TABLE "OrderIntake" (
    "orderId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "checkoutToken" TEXT,
    "cartToken" TEXT,
    "totalPrice" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "financialStatus" TEXT,
    "sourceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "attributionKind" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderIntake_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "AttributionKey" (
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "variant" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionKey_pkey" PRIMARY KEY ("kind","value")
);

-- CreateTable
CREATE TABLE "HealthSample" (
    "id" BIGSERIAL NOT NULL,
    "experimentId" TEXT,
    "check" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "detail" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceHeartbeat" (
    "source" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceHeartbeat_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
CREATE INDEX "OrderIntake_shop_status_createdAt_idx" ON "OrderIntake"("shop", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AttributionKey_visitorId_idx" ON "AttributionKey"("visitorId");

-- CreateIndex
CREATE INDEX "HealthSample_check_checkedAt_idx" ON "HealthSample"("check", "checkedAt");

-- CreateIndex
CREATE INDEX "HealthSample_experimentId_checkedAt_idx" ON "HealthSample"("experimentId", "checkedAt");
