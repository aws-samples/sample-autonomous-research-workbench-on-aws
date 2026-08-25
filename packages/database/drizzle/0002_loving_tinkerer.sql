ALTER TABLE "agent" ALTER COLUMN "persona" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "systemPrompt" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "preferredModel" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "tools" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "maxTokens" integer;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "reasoningEnabled" boolean;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "reasoningBudgetTokens" integer;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "reasoningEffort" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "historyStrategy" text DEFAULT 'sliding-window' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "historyWindowSize" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "historyPerTurn" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "userId" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "updatedAt" timestamp (3) DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_userId_idx" ON "agent" USING btree ("userId");