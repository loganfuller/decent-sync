-- CreateTable
CREATE TABLE "sign_in_windows" (
    "email" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_in_windows_pkey" PRIMARY KEY ("email")
);

-- CreateIndex
CREATE INDEX "sign_in_windows_started_at_idx" ON "sign_in_windows"("started_at");
