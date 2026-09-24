CREATE TABLE "dm_reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_reactions_message_id_user_id_emoji_key" UNIQUE("message_id","user_id","emoji")
);
--> statement-breakpoint
ALTER TABLE "dm_reactions" ADD CONSTRAINT "dm_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."direct_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_reactions" ADD CONSTRAINT "dm_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;