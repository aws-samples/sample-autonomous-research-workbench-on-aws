CREATE TABLE "agent_skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agentId" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_skill_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skillId" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"size" integer NOT NULL,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_agentId_agent_id_fk" FOREIGN KEY ("agentId") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_file" ADD CONSTRAINT "agent_skill_file_skillId_agent_skill_id_fk" FOREIGN KEY ("skillId") REFERENCES "public"."agent_skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skill_agentId_name_idx" ON "agent_skill" USING btree ("agentId","name");--> statement-breakpoint
CREATE INDEX "agent_skill_agentId_idx" ON "agent_skill" USING btree ("agentId");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skill_file_skillId_path_idx" ON "agent_skill_file" USING btree ("skillId","path");--> statement-breakpoint
CREATE INDEX "agent_skill_file_skillId_idx" ON "agent_skill_file" USING btree ("skillId");