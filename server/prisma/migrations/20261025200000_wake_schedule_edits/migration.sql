-- Ticket #231: a Settings Edit of the presence settings may add, change or
-- delete one wake schedule, named by the id Decaid gave it: for an add, the
-- id Decaid gave the new schedule, once answered.

CREATE TYPE "wake_schedule_action" AS ENUM ('ADD', 'CHANGE', 'DELETE');

ALTER TABLE "settings_edits" ADD COLUMN "schedule_action" "wake_schedule_action",
ADD COLUMN "schedule_id" TEXT;
