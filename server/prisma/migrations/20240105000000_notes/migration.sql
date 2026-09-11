-- CreateTable
CREATE TABLE "notes" (
    "id" BIGSERIAL NOT NULL,
    "public_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_delete_audit" (
    "id" BIGSERIAL NOT NULL,
    "note_id" BIGINT NOT NULL,
    "note_public_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "deleted_by" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_delete_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notes_public_id_key" ON "notes"("public_id");

-- CreateIndex: ownership + list sort in one index; user_id is the leading column so
-- it also serves plain user_id lookups.
CREATE INDEX "notes_user_created_idx" ON "notes"("user_id", "created_at");

-- CreateIndex: audit log is read back per actor (who deleted what, newest first).
CREATE INDEX "note_delete_audit_user_deleted_idx" ON "note_delete_audit"("deleted_by", "deleted_at");

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "note_delete_audit" ADD CONSTRAINT "note_delete_audit_deleted_by_fkey" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;