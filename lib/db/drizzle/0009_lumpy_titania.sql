CREATE TABLE "channel_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "category_id" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_categories" ADD CONSTRAINT "channel_categories_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_categories_server_position_idx" ON "channel_categories" USING btree ("server_id","position");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_category_id_channel_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."channel_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_category_position_idx" ON "channels" USING btree ("category_id","position");