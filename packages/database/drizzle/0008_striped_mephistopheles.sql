CREATE TYPE "public"."AgentRunStatus" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "agent_run" (
	"id" text PRIMARY KEY NOT NULL,
	"taskId" uuid NOT NULL,
	"status" "AgentRunStatus" DEFAULT 'queued' NOT NULL,
	"message" text NOT NULL,
	"costUsd" text,
	"durationMs" integer,
	"inputTokens" integer,
	"outputTokens" integer,
	"error" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"finishedAt" timestamp (3)
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "objective" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "flags" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "contextNotes" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "recommendedAgents" text;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_taskId_task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_taskId_idx" ON "agent_run" USING btree ("taskId");--> statement-breakpoint
CREATE INDEX "agent_run_status_idx" ON "agent_run" USING btree ("status");