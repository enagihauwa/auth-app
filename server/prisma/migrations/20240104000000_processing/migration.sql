-- CreateEnum
CREATE TYPE "ProcessingJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "ProcessingJobKind" AS ENUM ('EXTRACT', 'EDIT');

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" SERIAL NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "ProcessingJobKind" NOT NULL,
    "status" "ProcessingJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "input" JSONB,
    "result" JSONB,
    "parent_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_files" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processing_jobs_user_id_idx" ON "processing_jobs"("user_id");

-- CreateIndex
CREATE INDEX "processing_jobs_status_created_at_idx" ON "processing_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "processing_files_job_id_idx" ON "processing_files"("job_id");

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "processing_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "processing_files" ADD CONSTRAINT "processing_files_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "processing_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;