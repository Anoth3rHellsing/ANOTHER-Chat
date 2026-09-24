CREATE TABLE "channel_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"creator_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"original_time_zone" text NOT NULL,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"status" text NOT NULL,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_responses_event_id_user_id_key" UNIQUE("event_id","user_id"),
	CONSTRAINT "event_responses_status_check" CHECK ("event_responses"."status" in ('yes', 'no', 'maybe'))
);
--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_responses" ADD CONSTRAINT "event_responses_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."channel_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_responses" ADD CONSTRAINT "event_responses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_events_channel_id_starts_at_idx" ON "channel_events" USING btree ("channel_id","starts_at");