-- 백과사전 카테고리 정규화 (2026-06-11)
-- 중복 카테고리 통합: 보철치료→보철, 보존치료→보존, 심미치료→심미, 예방치료→예방
UPDATE encyclopedia SET category = '보철' WHERE category = '보철치료';
UPDATE encyclopedia SET category = '보존' WHERE category = '보존치료';
UPDATE encyclopedia SET category = '심미' WHERE category = '심미치료';
UPDATE encyclopedia SET category = '예방' WHERE category = '예방치료';
