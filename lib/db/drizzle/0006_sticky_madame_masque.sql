CREATE TABLE "channel_file_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"uploaded_by" integer NOT NULL,
	"filename" text NOT NULL,
	"expected_bytes" integer NOT NULL,
	"received_bytes" integer DEFAULT 0 NOT NULL,
	"storage_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"uploaded_by" integer NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"scan_status" text DEFAULT 'not_started' NOT NULL,
	"scan_source" text,
	"scan_harmless" integer,
	"scan_undetected" integer,
	"scan_suspicious" integer,
	"scan_malicious" integer,
	"scan_submitted_by" integer,
	"scan_submitted_at" timestamp with time zone,
	"scan_completed_at" timestamp with time zone,
	"scan_analysis_id" text,
	"scan_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "virus_total_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_file_uploads" ADD CONSTRAINT "channel_file_uploads_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_file_uploads" ADD CONSTRAINT "channel_file_uploads_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_files" ADD CONSTRAINT "channel_files_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_files" ADD CONSTRAINT "channel_files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_files" ADD CONSTRAINT "channel_files_scan_submitted_by_fkey" FOREIGN KEY ("scan_submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_file_uploads_expires_at_idx" ON "channel_file_uploads" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "channel_files_channel_id_created_at_idx" ON "channel_files" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "channel_files_sha256_idx" ON "channel_files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "virus_total_requests_requested_at_idx" ON "virus_total_requests" USING btree ("requested_at");