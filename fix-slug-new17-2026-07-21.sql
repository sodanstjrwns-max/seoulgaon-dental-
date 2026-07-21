-- ══════════════════════════════════════════════════════════════
-- 2026-07-08 추가된 백과사전 17개(id 302~318) slug 교정
-- 문제: slug 칸에 영문 제목(대문자/공백/슬래시)을 그대로 입력 → URL 깨짐 → 색인 불가
-- 조치: 표준 영문 slug로 교정 + slug_redirects에 옛(깨진) slug → 새 slug 301 매핑 등록
-- ══════════════════════════════════════════════════════════════

-- ── 1) slug_redirects에 옛 slug → 새 slug 매핑 먼저 등록 (301 유지) ──
INSERT OR REPLACE INTO slug_redirects (old_slug, new_slug) VALUES
  ('Tooth Sensitivity / Dentin Hypersensitivity', 'tooth-sensitivity'),
  ('CTG, Connective Tissue Graft',                'connective-tissue-graft'),
  ('FGG, Free Gingival Graft',                    'free-gingival-graft'),
  ('Vestibuloplasty',                             'vestibuloplasty'),
  ('Composite Resin Restoration',                 'composite-resin-restoration'),
  ('Crown / 치과 크라운',                          'crown'),
  ('Dental Insurance',                            'dental-insurance'),
  ('Post-Whitening Care',                         'post-whitening-care'),
  ('Painless Injection / Computerized Anesthesia','painless-injection'),
  ('Dental Anxiety / Dental Phobia',              'dental-anxiety'),
  ('Dental Floss',                                'dental-floss'),
  ('Implant Maintenance',                         'implant-maintenance'),
  ('Toothbrushing Technique',                     'toothbrushing-technique'),
  ('Fluoride Toothpaste',                         'fluoride-toothpaste'),
  ('Tooth Replacement Timing',                    'tooth-replacement-timing'),
  ('Oral Irrigator / Water Flosser',              'oral-irrigator'),
  ('Periodontal Pathogens',                       'periodontal-pathogens');

-- ── 2) encyclopedia slug 교정 (id 기준으로 정확히 지정) ──
UPDATE encyclopedia SET slug = 'tooth-sensitivity'           WHERE id = 302;
UPDATE encyclopedia SET slug = 'connective-tissue-graft'     WHERE id = 303;
UPDATE encyclopedia SET slug = 'free-gingival-graft'         WHERE id = 304;
UPDATE encyclopedia SET slug = 'vestibuloplasty'             WHERE id = 305;
UPDATE encyclopedia SET slug = 'composite-resin-restoration' WHERE id = 306;
-- id 307 '크라운'은 id 127 '치관'(dental-crown)과 slug 충돌. term은 다르므로 둘 다 유지, slug만 분리.
UPDATE encyclopedia SET slug = 'crown'                       WHERE id = 307;
UPDATE encyclopedia SET slug = 'dental-insurance'            WHERE id = 308;
UPDATE encyclopedia SET slug = 'post-whitening-care'         WHERE id = 309;
UPDATE encyclopedia SET slug = 'painless-injection'          WHERE id = 310;
-- id 311 '치과 공포증'은 id 110(dental-anxiety)과 중복 term.
-- 새 내용(311)이 2배 알참 → 기존 URL(dental-anxiety, 조회수 60) 승계.
-- 구버전(110)은 비공개 + legacy 처리하여 중복 제거. (2단계 tmp로 UNIQUE 충돌 회피)
UPDATE encyclopedia SET slug = 'dental-anxiety-legacy', is_published = 0 WHERE id = 110;
UPDATE encyclopedia SET slug = 'dental-anxiety'                          WHERE id = 311;
UPDATE encyclopedia SET slug = 'dental-floss'                WHERE id = 312;
UPDATE encyclopedia SET slug = 'implant-maintenance'         WHERE id = 313;
UPDATE encyclopedia SET slug = 'toothbrushing-technique'     WHERE id = 314;
UPDATE encyclopedia SET slug = 'fluoride-toothpaste'         WHERE id = 315;
UPDATE encyclopedia SET slug = 'tooth-replacement-timing'    WHERE id = 316;
-- id 317 '구강 세정기'는 id 97 '구강세정기'(oral-irrigator)와 사실상 동일 주제.
-- 신규(317)가 2배 알참 → 기존 URL(oral-irrigator, 조회수 48) 승계, 구버전(97)은 비공개.
UPDATE encyclopedia SET slug = 'oral-irrigator-legacy', is_published = 0 WHERE id = 97;
UPDATE encyclopedia SET slug = 'oral-irrigator'                          WHERE id = 317;
UPDATE encyclopedia SET slug = 'periodontal-pathogens'       WHERE id = 318;
