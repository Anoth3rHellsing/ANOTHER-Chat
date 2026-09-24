CREATE TABLE "soundboard_clips" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"url" text NOT NULL,
	"uploaded_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "soundboard_clips" ADD CONSTRAINT "soundboard_clips_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "soundboard_clips" ADD CONSTRAINT "soundboard_clips_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "soundboard_clips_server_id_idx" ON "soundboard_clips" USING btree ("server_id");