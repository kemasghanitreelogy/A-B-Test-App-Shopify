-- Which orders and add-to-carts a product experiment counts (target-product filter, 4 Nov 2026).
-- Additive with a default: existing experiments keep the target-product filter.
ALTER TABLE "Experiment" ADD COLUMN "conversionScope" TEXT NOT NULL DEFAULT 'target_products';
