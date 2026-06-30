-- 중복 용어 통합 v18 (2026-06-30): 내용 풍부한 쪽 살리고 빈약한 쪽 비공개+slug 양보
-- STEP 1: 빈약한 중복 비공개 + slug 양보 (tmp로 비움)
UPDATE encyclopedia SET is_published = 0, slug = 'scaling-legacy'     WHERE id = 4;
UPDATE encyclopedia SET is_published = 0, slug = 'occlusion-legacy'   WHERE id = 132;
UPDATE encyclopedia SET is_published = 0, slug = 'xerostomia-legacy'  WHERE id = 31;
UPDATE encyclopedia SET is_published = 0, slug = 'root-canal-legacy'  WHERE id = 2;

-- STEP 2: 풍부한 쪽에 클린 slug 배정
UPDATE encyclopedia SET slug = 'scaling'    WHERE id = 23;
UPDATE encyclopedia SET slug = 'occlusion'  WHERE id = 206;
UPDATE encyclopedia SET slug = 'xerostomia' WHERE id = 288;
UPDATE encyclopedia SET slug = 'root-canal' WHERE id = 290;
