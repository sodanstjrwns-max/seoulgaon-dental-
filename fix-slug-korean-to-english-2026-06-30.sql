-- 한글 slug -> 영문 통일 v19 (2026-06-30)
-- 기존 한글 URL은 코드의 id 기반 301 핸들러로 새 slug에 자동 연결됨

-- 순수/혼합 한글 slug -> 영문
UPDATE encyclopedia SET slug = 'osseointegration'         WHERE id = 7;   -- 골유착
UPDATE encyclopedia SET slug = 'implant-insurance'        WHERE id = 19;  -- 건강보험 임플란트
UPDATE encyclopedia SET slug = 'gingival-enlargement'     WHERE id = 76;  -- 치은비대
UPDATE encyclopedia SET slug = 'tooth-structure'          WHERE id = 138; -- 치아 구조
UPDATE encyclopedia SET slug = 'emax-lithium-disilicate'  WHERE id = 254; -- e.max / 리튬디실리케이트
UPDATE encyclopedia SET slug = 'resin-buildup-procedure'  WHERE id = 6;   -- 레진빌드업(중복, 별도 용어)

-- 충치/우식 중복: id122(496자) 살림, id155(우식) 비공개
UPDATE encyclopedia SET is_published = 0, slug = 'dental-caries-legacy' WHERE id = 155;
