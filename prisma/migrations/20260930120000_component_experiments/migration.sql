-- Component experiments (claudedocs/SPEC-component-experiments.md)
ALTER TABLE "Experiment" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'template';
ALTER TABLE "Experiment" ADD COLUMN "component" TEXT;
