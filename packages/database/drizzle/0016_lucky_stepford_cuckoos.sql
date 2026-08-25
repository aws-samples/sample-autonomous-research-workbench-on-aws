-- Backfill: projects created before the mandatory budget cap (or with the
-- cap explicitly removed) get the default before the column goes NOT NULL.
UPDATE "project" SET "maxBudgetUsd" = 100 WHERE "maxBudgetUsd" IS NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "maxBudgetUsd" SET NOT NULL;
