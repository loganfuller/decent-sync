-- Ticket #229: the Tablet's UTC offset, in minutes east of UTC, kept with the
-- value of a collection reported with one (`appSettings` and
-- `presenceSettings`), whose times are in the Tablet's own time.

ALTER TABLE "reported_collections" ADD COLUMN "utc_offset_minutes" INTEGER;
