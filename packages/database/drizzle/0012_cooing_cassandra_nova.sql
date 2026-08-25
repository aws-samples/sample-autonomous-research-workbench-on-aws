CREATE TYPE "public"."IndexStatus" AS ENUM('pending', 'indexed', 'failed');--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sourceKey" text NOT NULL,
	"fileName" text NOT NULL,
	"documentId" text,
	"indexStatus" "IndexStatus" DEFAULT 'pending' NOT NULL,
	"indexedAt" timestamp (3),
	"graphIndexStatus" "IndexStatus" DEFAULT 'pending' NOT NULL,
	"graphIndexedAt" timestamp (3),
	"lastError" text,
	"createdAt" timestamp (3) DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "agentRuntimeArn" text;--> statement-breakpoint
CREATE UNIQUE INDEX "document_sourceKey_idx" ON "document" USING btree ("sourceKey");--> statement-breakpoint
CREATE INDEX "document_indexStatus_idx" ON "document" USING btree ("indexStatus");--> statement-breakpoint
CREATE INDEX "document_graphIndexStatus_idx" ON "document" USING btree ("graphIndexStatus");