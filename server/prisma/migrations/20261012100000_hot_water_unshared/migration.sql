-- Hot water leaves a Location's shared settings (ADR-0014, ticket #137): each
-- Machine's hot water is its own, set by its Loaded Recipe (ADR-0022), and
-- the shared settings are steam and rinse alone. Pre-v1, nothing keeps them
-- (ADR-0016): the hot water fields are dropped from each Location's settings,
-- their latest edits, each tablet's settings as it last had them, and the
-- settings' versions and Conflicts, with each version that set nothing else.

UPDATE "location_settings" SET
  "values" = "values" - ARRAY['hotWaterData.targetTemperature', 'hotWaterData.duration', 'hotWaterData.volume', 'hotWaterData.flow'],
  "field_edits" = "field_edits" - ARRAY['hotWaterData.targetTemperature', 'hotWaterData.duration', 'hotWaterData.volume', 'hotWaterData.flow'];

UPDATE "tablet_settings" SET
  "values" = "values" - ARRAY['hotWaterData.targetTemperature', 'hotWaterData.duration', 'hotWaterData.volume', 'hotWaterData.flow'];

DELETE FROM "conflicts" WHERE "kind" = 'settings' AND "field" LIKE 'hotWaterData.%';

UPDATE "item_versions" SET
  "fields" = "fields" - ARRAY['hotWaterData.targetTemperature', 'hotWaterData.duration', 'hotWaterData.volume', 'hotWaterData.flow']
WHERE "kind" = 'settings';

DELETE FROM "item_versions" WHERE "kind" = 'settings' AND "fields" = '{}'::jsonb;
