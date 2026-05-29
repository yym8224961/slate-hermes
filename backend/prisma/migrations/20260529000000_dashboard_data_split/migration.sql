-- Backfill dashboard current data from the legacy config.test_data field.
UPDATE `contents`
SET `dynamic_data` = JSON_EXTRACT(`dynamic_config`, '$.test_data')
WHERE `kind` = 'dynamic'
  AND `dynamic_type` = 'dashboard'
  AND `dynamic_data` IS NULL
  AND JSON_EXTRACT(`dynamic_config`, '$.test_data') IS NOT NULL;

-- dashboard config is render configuration only; current data lives in dynamic_data.
UPDATE `contents`
SET `dynamic_config` = JSON_REMOVE(`dynamic_config`, '$.test_data')
WHERE `kind` = 'dynamic'
  AND `dynamic_type` = 'dashboard'
  AND JSON_EXTRACT(`dynamic_config`, '$.test_data') IS NOT NULL;
