-- Ticket #703: a Bean Batch holds a Batch Code, the roaster's own identifier
-- for it, in its content (`batchCode`), unique among the batches that are not
-- Archived, compared ignoring case and the spaces around it. An Archived
-- batch's code is free for another batch to take.
--
-- No release before this one writes a `batchCode`, so the index refuses none
-- of the latest release's writes of a batch's content (ADR-0025). The one
-- write of its it can refuse is restoring an Archived batch whose code
-- another batch has taken since, through an instance of that release still
-- serving during a deploy: that release answers it with an error, and this
-- one with a conflict naming the batch that holds the code.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX "bean_batches_batch_code_key" ON "bean_batches" (lower(btrim("content" ->> 'batchCode'))) WHERE NOT "archived";

COMMIT;
