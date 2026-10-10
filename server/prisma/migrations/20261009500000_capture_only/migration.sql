-- The capture-only switch: whether a Machine takes part in the Library at its
-- Location, on unless an Admin turned sharing off, and when sharing was last
-- turned back on, which each of its tablet's reports records, so the first
-- since is part of joining the Location (server/src/library/joining.ts).

-- AlterTable
ALTER TABLE "machines" ADD COLUMN     "sharing" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sharing_since" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "tablet_reports" ADD COLUMN     "sharing_since" TIMESTAMPTZ(3);
