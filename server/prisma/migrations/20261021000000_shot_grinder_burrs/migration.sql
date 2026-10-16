-- The burrs fitted to a Shot's Grinder as it was pulled, as Decaid v0.9.0
-- and later copy them onto a Shot they pull, for analytics by Grinder and
-- burrs.
-- Shots stored before this keep none until they are stored again.

-- AlterTable
ALTER TABLE "shots" ADD COLUMN     "grinder_burrs" TEXT;
