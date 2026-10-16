CREATE TABLE "matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"home_team_id" integer NOT NULL,
	"away_team_id" integer NOT NULL,
	"home_score" integer,
	"away_score" integer,
	"status" text DEFAULT 'not_started' NOT NULL,
	"match_time" text NOT NULL,
	"match_day" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "predictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"match_id" integer NOT NULL,
	"home_score" integer NOT NULL,
	"away_score" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password" text NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "visitors" (
	"id" serial PRIMARY KEY NOT NULL,
	"ip_address" text NOT NULL,
	"visit_count" integer DEFAULT 1 NOT NULL,
	"first_visit" timestamp DEFAULT now() NOT NULL,
	"last_visit" timestamp DEFAULT now() NOT NULL,
	"user_agent" text,
	"location" text,
	"device_info" text,
	"referrer" text,
	"screen_resolution" text
);
