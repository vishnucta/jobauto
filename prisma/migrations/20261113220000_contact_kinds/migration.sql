-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('AGENCY', 'HIRING_MANAGER', 'REFERRAL');

-- AlterTable
ALTER TABLE "Recruiter" ADD COLUMN     "kind" "ContactKind" NOT NULL DEFAULT 'AGENCY',
ADD COLUMN     "relation" TEXT NOT NULL DEFAULT '';
