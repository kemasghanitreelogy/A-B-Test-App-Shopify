-- First-party behavioural events (cart drawer tracking)
CREATE TABLE "InteractionEvent" (
    "id" BIGSERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "ui" TEXT,
    "action" TEXT,
    "detail" TEXT,
    "variantId" TEXT,
    "value" DECIMAL(14,2),
    "ms" INTEGER,
    "visitorId" TEXT,
    "sessionId" TEXT,
    "gaClientId" TEXT,
    "ab" TEXT,
    "pagePath" TEXT,
    "locale" TEXT,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InteractionEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InteractionEvent_uuid_key" ON "InteractionEvent"("uuid");
CREATE INDEX "InteractionEvent_shop_name_occurredAt_idx" ON "InteractionEvent"("shop", "name", "occurredAt");
CREATE INDEX "InteractionEvent_surface_occurredAt_idx" ON "InteractionEvent"("surface", "occurredAt");
CREATE INDEX "InteractionEvent_visitorId_idx" ON "InteractionEvent"("visitorId");
