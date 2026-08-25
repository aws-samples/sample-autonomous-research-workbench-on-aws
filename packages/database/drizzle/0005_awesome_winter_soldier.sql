CREATE TABLE "extraction_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updatedBy" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_template_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "extraction_template" ADD CONSTRAINT "extraction_template_updatedBy_user_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;