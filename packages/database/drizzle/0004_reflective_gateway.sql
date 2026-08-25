CREATE TABLE "project_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sessionId" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"agentRuntimeSessionId" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_message" ADD CONSTRAINT "project_message_sessionId_project_session_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."project_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_session" ADD CONSTRAINT "project_session_projectId_project_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_message_sessionId_idx" ON "project_message" USING btree ("sessionId");--> statement-breakpoint
CREATE UNIQUE INDEX "project_session_projectId_idx" ON "project_session" USING btree ("projectId");