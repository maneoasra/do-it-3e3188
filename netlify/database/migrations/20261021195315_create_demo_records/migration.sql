CREATE TABLE "demo_records" (
	"key" text PRIMARY KEY,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
