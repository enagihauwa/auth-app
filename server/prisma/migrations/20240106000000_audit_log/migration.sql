-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "detail" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: read-back per actor, newest first.
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log"("actor_id", "created_at");

-- CreateIndex: lookups by action type (e.g. security review of a single action).
CREATE INDEX "audit_log_action_created_idx" ON "audit_log"("action", "created_at");

-- AddForeignKey: actor rows survive user deletion.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;