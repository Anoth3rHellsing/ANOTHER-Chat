CREATE TABLE "channel_categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE "channels" ADD COLUMN "category_id" integer REFERENCES "channel_categories"("id") ON DELETE SET NULL;
ALTER TABLE "channels" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;
CREATE INDEX "channel_categories_server_position_idx" ON "channel_categories" ("server_id", "position");
CREATE INDEX "channels_category_position_idx" ON "channels" ("category_id", "position");