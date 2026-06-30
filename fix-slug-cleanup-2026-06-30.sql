-- ════════════════════════════════════════════════════════════
-- 백과사전 slug 정리 v16 (2026-06-30) — 2단계 방식 (UNIQUE 충돌 회피)
-- 목적: 6/11 작업의 오타 slug 수정 + 중복 용어 통합
-- ════════════════════════════════════════════════════════════

-- ── STEP 1: 대상 행 전부 임시 slug로 비우기 (충돌 원천 제거) ──
UPDATE encyclopedia SET slug = 'tmp-25'  WHERE id = 25;
UPDATE encyclopedia SET slug = 'tmp-118' WHERE id = 118;
UPDATE encyclopedia SET slug = 'tmp-50'  WHERE id = 50;
UPDATE encyclopedia SET slug = 'tmp-14'  WHERE id = 14;
UPDATE encyclopedia SET slug = 'tmp-117' WHERE id = 117;
UPDATE encyclopedia SET slug = 'tmp-130' WHERE id = 130;
UPDATE encyclopedia SET slug = 'tmp-204' WHERE id = 204;
UPDATE encyclopedia SET slug = 'tmp-10'  WHERE id = 10;
UPDATE encyclopedia SET slug = 'tmp-109' WHERE id = 109;
UPDATE encyclopedia SET slug = 'tmp-206' WHERE id = 206;
UPDATE encyclopedia SET slug = 'tmp-12'  WHERE id = 12;
UPDATE encyclopedia SET slug = 'tmp-64'  WHERE id = 64;

-- ── STEP 2: 최종 slug 배정 + 중복 비공개 ──
-- 치석: id118(529자) 살림, id25(중복) 비공개
UPDATE encyclopedia SET slug = 'dental-calculus' WHERE id = 118;
UPDATE encyclopedia SET slug = 'dental-calculus-legacy', is_published = 0 WHERE id = 25;

-- 골드 크라운: gold-crow -> gold-crown
UPDATE encyclopedia SET slug = 'gold-crown' WHERE id = 50;

-- 실활치미백: id117(566자) 살림, id14(동의어) 비공개
UPDATE encyclopedia SET slug = 'walking-bleach' WHERE id = 117;
UPDATE encyclopedia SET slug = 'walking-bleach-legacy', is_published = 0 WHERE id = 14;

-- 영구치: id204(536자) 살림, id130 비공개
UPDATE encyclopedia SET slug = 'permanent-teeth' WHERE id = 204;
UPDATE encyclopedia SET slug = 'permanent-teeth-legacy', is_published = 0 WHERE id = 130;

-- 레진빌드업: id109(579자) 살림, id10 비공개
UPDATE encyclopedia SET slug = 'resin-buildup' WHERE id = 109;
UPDATE encyclopedia SET slug = 'resin-buildup-legacy', is_published = 0 WHERE id = 10;

-- 교합: id206 -> occlusion
UPDATE encyclopedia SET slug = 'occlusion' WHERE id = 206;

-- 뼈이식술: id12(5625자) -> bone-graft, GBR(id64) -> 소문자 gbr
UPDATE encyclopedia SET slug = 'bone-graft' WHERE id = 12;
UPDATE encyclopedia SET slug = 'gbr' WHERE id = 64;
