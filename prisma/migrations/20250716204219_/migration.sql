-- CreateTable
CREATE TABLE "Analyze" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "result" JSONB NOT NULL,

    CONSTRAINT "Analyze_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Analyze_identifier_key" ON "Analyze"("identifier");
