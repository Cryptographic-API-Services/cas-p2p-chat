CREATE TABLE "peers" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"name_key" text,
	"record" jsonb,
	"timestamp" bigint NOT NULL,
	"first_seen" bigint NOT NULL,
	"last_seen" bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE INDEX "peers_last_seen" ON "peers" USING btree ("last_seen");