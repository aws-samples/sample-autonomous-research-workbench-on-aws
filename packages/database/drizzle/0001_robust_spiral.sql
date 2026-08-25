CREATE TYPE "public"."CodeInterpreterSessionStatus" AS ENUM('active', 'stopped', 'expired');--> statement-breakpoint
CREATE TYPE "public"."TaskStatus" AS ENUM('running', 'completed', 'failed', 'timed_out');--> statement-breakpoint
CREATE TABLE "code_interpreter_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"taskId" uuid NOT NULL,
	"sessionId" text NOT NULL,
	"status" "CodeInterpreterSessionStatus" DEFAULT 'active' NOT NULL,
	"expiresAt" timestamp (3) NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"status" "TaskStatus" DEFAULT 'running' NOT NULL,
	"agent" text NOT NULL,
	"agentHistory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"userId" text,
	"deletedAt" timestamp (3),
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"metadata" jsonb,
	"taskId" uuid NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_interpreter_session" ADD CONSTRAINT "code_interpreter_session_taskId_task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_message" ADD CONSTRAINT "task_message_taskId_task_id_fk" FOREIGN KEY ("taskId") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "code_interpreter_session_taskId_idx" ON "code_interpreter_session" USING btree ("taskId");--> statement-breakpoint
CREATE INDEX "code_interpreter_session_status_idx" ON "code_interpreter_session" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_userId_idx" ON "task" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "task_status_idx" ON "task" USING btree ("status");--> statement-breakpoint
CREATE INDEX "task_deletedAt_idx" ON "task" USING btree ("deletedAt");--> statement-breakpoint
CREATE INDEX "task_message_taskId_idx" ON "task_message" USING btree ("taskId");--> statement-breakpoint
CREATE UNIQUE INDEX "code_interpreter_session_active_taskId_idx" ON "code_interpreter_session" USING btree ("taskId") WHERE "status" = 'active';