CREATE TYPE "public"."PlanTaskStatus" AS ENUM('pending', 'spawned', 'succeeded', 'failed', 'cancelled', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."ProjectAgentState" AS ENUM('idle', 'working', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."RunStatus" AS ENUM('pending', 'planning', 'running', 'waiting_on_children', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "plan_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"childRunId" uuid,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"agentType" text NOT NULL,
	"spec" jsonb NOT NULL,
	"dependsOn" uuid[] DEFAULT '{}' NOT NULL,
	"status" "PlanTaskStatus" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parentRunId" uuid,
	"rootRunId" uuid NOT NULL,
	"agentType" text NOT NULL,
	"status" "RunStatus" DEFAULT 'pending' NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"checkpoint" jsonb,
	"error" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 3 NOT NULL,
	"costUsd" double precision DEFAULT 0 NOT NULL,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"cacheReadTokens" integer DEFAULT 0 NOT NULL,
	"cacheWriteTokens" integer DEFAULT 0 NOT NULL,
	"deadlineAt" timestamp (3),
	"taskId" uuid,
	"projectId" uuid,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"startedAt" timestamp (3),
	"finishedAt" timestamp (3),
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_event" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_event_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"runId" uuid NOT NULL,
	"rootRunId" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_message" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_message_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"runId" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "leadModel" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "leadSystemPrompt" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "maxBudgetUsd" double precision;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "budgetExceededAt" timestamp (3);--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "leadTaskId" uuid;--> statement-breakpoint
ALTER TABLE "project_agent" ADD COLUMN "state" "ProjectAgentState" DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_agent" ADD COLUMN "activeRunId" uuid;--> statement-breakpoint
ALTER TABLE "project_agent" ADD COLUMN "lastResult" jsonb;--> statement-breakpoint
ALTER TABLE "project_agent" ADD COLUMN "stateUpdatedAt" timestamp (3);--> statement-breakpoint
ALTER TABLE "plan_task" ADD CONSTRAINT "plan_task_runId_run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_task" ADD CONSTRAINT "plan_task_childRunId_run_id_fk" FOREIGN KEY ("childRunId") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_parentRunId_run_id_fk" FOREIGN KEY ("parentRunId") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_taskId_task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_projectId_project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_event" ADD CONSTRAINT "run_event_runId_run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_message" ADD CONSTRAINT "run_message_runId_run_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_task_runId_idx" ON "plan_task" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "plan_task_childRunId_idx" ON "plan_task" USING btree ("childRunId");--> statement-breakpoint
CREATE INDEX "run_rootRunId_idx" ON "run" USING btree ("rootRunId");--> statement-breakpoint
CREATE INDEX "run_parentRunId_idx" ON "run" USING btree ("parentRunId");--> statement-breakpoint
CREATE INDEX "run_taskId_idx" ON "run" USING btree ("taskId");--> statement-breakpoint
CREATE INDEX "run_projectId_idx" ON "run" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "run_active_status_idx" ON "run" USING btree ("status") WHERE "run"."status" IN ('pending', 'planning', 'running', 'waiting_on_children');--> statement-breakpoint
CREATE UNIQUE INDEX "run_event_runId_seq_idx" ON "run_event" USING btree ("runId","seq");--> statement-breakpoint
CREATE INDEX "run_event_rootRunId_idx" ON "run_event" USING btree ("rootRunId","id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_message_runId_seq_idx" ON "run_message" USING btree ("runId","seq");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_leadTaskId_task_id_fk" FOREIGN KEY ("leadTaskId") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_agent" ADD CONSTRAINT "project_agent_activeRunId_run_id_fk" FOREIGN KEY ("activeRunId") REFERENCES "public"."run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_agent_activeRunId_idx" ON "project_agent" USING btree ("activeRunId");