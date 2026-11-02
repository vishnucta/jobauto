-- AlterEnum
ALTER TYPE "PostingSource" ADD VALUE 'CLIENT';

-- AlterTable
ALTER TABLE "PostingSearch" ADD COLUMN     "addedBy" TEXT NOT NULL DEFAULT '';
