-- CreateTable (notifier-owned dedupe ledger)
CREATE TABLE "notified_jobs" (
    "jobId" TEXT NOT NULL,
    "notifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notified_jobs_pkey" PRIMARY KEY ("jobId")
);
