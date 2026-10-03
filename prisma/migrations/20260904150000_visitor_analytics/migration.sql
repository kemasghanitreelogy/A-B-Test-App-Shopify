-- CreateTable
CREATE TABLE "VisitorAnalytics" (
    "visitorId" TEXT NOT NULL,
    "ga4ClientId" TEXT NOT NULL,
    "ga4SessionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VisitorAnalytics_pkey" PRIMARY KEY ("visitorId")
);
