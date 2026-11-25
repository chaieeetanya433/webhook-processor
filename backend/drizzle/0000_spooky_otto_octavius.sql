CREATE TABLE "event_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"worker_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"result" text,
	"error" text,
	CONSTRAINT "uq_event_attempts_event_attempt" UNIQUE("event_id","attempt_number"),
	CONSTRAINT "event_attempts_result_check" CHECK ("event_attempts"."result" IN ('success', 'failure', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"attempts_in_budget" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"conflicting_payload_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "events_status_check" CHECK ("events"."status" IN ('pending', 'processing', 'succeeded', 'failed_permanent'))
);
--> statement-breakpoint
CREATE TABLE "processed_orders" (
	"order_id" text NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_orders_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "event_attempts" ADD CONSTRAINT "event_attempts_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_orders" ADD CONSTRAINT "processed_orders_event_id_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_status_next_run_at" ON "events" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_events_status_lease_expires_at" ON "events" USING btree ("status","lease_expires_at");