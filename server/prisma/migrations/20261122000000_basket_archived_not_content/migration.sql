-- Ticket #618: from DYE2 v0.1.41 a barista can archive a Basket in DYE2,
-- which sets `archived` on its record. Releases before this one took that
-- field in as a field of the Basket's content, shared with every Location,
-- so it left every tablet's picker while the management interface showed it
-- shown and not Archived. From this release `archived` on a tablet's record
-- is whether its Location hides the Basket, never content. Every Basket's
-- content, and its fields' latest edits, lose `archived`, and an open
-- Conflict over it is dismissed; no Location's state changes, so a Basket
-- archived so reappears wherever it is shown, to be archived again where
-- that was meant (UPGRADING.md). No version is kept: `archived` was never a
-- field of a Basket's content. Its tablets' records are left as they are,
-- and written again where their Location's state differs. It changes data,
-- which the owner approved on 2026-11-22 (docs/AI_STORAGE_NOTES.md). 1.12.1,
-- which may still serve beside it for a deploy's overlap, may take a
-- tablet's `archived` in as content again, which this release reads as no
-- content wherever it reads a Basket's (`equipmentContent`).

BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE "baskets" SET
  "content" = "content" - 'archived',
  "field_edits" = "field_edits" - 'archived'
WHERE "content" ? 'archived' OR COALESCE("field_edits" ? 'archived', false);

UPDATE "conflicts" SET "state" = 'DISMISSED'
WHERE "kind" = 'basket' AND "field" = 'archived' AND "location_id" IS NULL AND "state" = 'OPEN';

COMMIT;
