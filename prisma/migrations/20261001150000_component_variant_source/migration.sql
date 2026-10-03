-- Component experiments with variant B built from a draft theme (SPEC-component-experiments §10).
-- Additive, nullable: existing rows keep the fallback B.
ALTER TABLE "Experiment" ADD COLUMN     "variantBEntries" JSONB,
ADD COLUMN     "variantBSourceThemeId" TEXT,
ADD COLUMN     "variantBSourceThemeName" TEXT;
