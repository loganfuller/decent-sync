-- Ticket #225: whether a Settings Edit's answer came late, after the edit was
-- marked not confirmed (60 s after it was made, or its connection stopped
-- holding the Machine first).

ALTER TABLE "settings_edits" ADD COLUMN "late" BOOLEAN NOT NULL DEFAULT false;
