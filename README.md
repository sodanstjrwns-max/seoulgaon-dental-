# 서울가온치과 공식 웹사이트

## Project Overview
- **Name**: 서울가온치과 (Seoul Gaon Dental Clinic)
- **Version**: v12 — Sitemap Pro Upgrade
- **Type**: Hono + Cloudflare Pages (SSR + Static) — D1 Database + R2 Storage
- **Target**: 의정부 서울가온치과의원 (현진호 대표원장)

## URLs
- **Production**: https://seoulgaondc.kr (custom domain)
- **Cloudflare**: https://seoulgaon-dental.pages.dev
- **GitHub**: https://github.com/sodanstjrwns-max/seoulgaon-dental-
- **Sitemap Index**: https://seoulgaondc.kr/sitemap.xml (3 sub-sitemaps, 251 URLs)
- **Sitemap Pages**: https://seoulgaondc.kr/sitemap-pages.xml (41 URLs)
- **Sitemap Blog**: https://seoulgaondc.kr/sitemap-blog.xml (127 URLs)
- **Sitemap BA**: https://seoulgaondc.kr/sitemap-before-after.xml (83 URLs)
- **LLMs.txt**: https://seoulgaondc.kr/llms.txt (AI 검색엔진용)
- **Phone**: 0507-1325-3377

## SEO 랜딩페이지 (26개 — SSR)
| # | Page | URL | Target Keywords |
|---|------|-----|-----------------|
| 1 | 심미치료 | `/aesthetic` | 의정부 심미치료 |
| 2 | 레진빌드업 | `/resin-buildup` | 의정부 레진빌드업 |
| 3 | 임플란트 | `/implant` | 의정부 임플란트 |
| 4 | 의정부 치과 | `/uijeongbu-dental` | 의정부 치과 추천 |
| 5 | 신경치료 | `/endodontics` | 의정부 신경치료 |
| 6 | 인비절라인 | `/invisalign` | 의정부 인비절라인 |
| 7 | 치아교정 | `/orthodontics` | 의정부 치아교정 |
| 8 | 글로우네이트 | `/glownate` | 의정부 글로우네이트 |
| 9 | 충치치료 | `/cavity-treatment` | 의정부 충치치료 |
| 10 | 임플란트 잘하는곳 | `/implant-best` | 의정부 임플란트 잘하는곳 |
| 11 | 전체 임플란트 | `/full-mouth-implant` | 의정부 전체임플란트 |
| 12 | 앞니 임플란트 | `/front-tooth-implant` | 의정부 앞니 임플란트 |
| 13 | 뼈이식 임플란트 | `/bone-graft-implant` | 의정부 뼈이식 임플란트 |
| 14 | 라미네이트 | `/laminate` | 의정부 라미네이트 |
| 15 | 사랑니 | `/wisdom-tooth` | 의정부 사랑니 발치 |
| 16 | 스케일링·잇몸 | `/scaling-gum-treatment` | 의정부 스케일링 잇몸치료 |
| 17 | 틀니→임플란트 | `/denture-to-implant` | 의정부 틀니 임플란트 |
| 18 | 임플란트 비용 | `/implant-cost` | 의정부 임플란트 가격 비용 |
| 19 | 야간진료 | `/night-dental` | 의정부 야간진료 치과 |
| 20 | 노인 임플란트 | `/senior-implant` | 노인 임플란트 65세 보험 |
| 21 | 응급치과 | `/emergency-dental` | 의정부 응급치과 치통 |
| 22 | 탑석역 치과 | `/tapseok-dental` | 탑석역 치과 |
| 23 | 무통치료 | `/painless-dental` | 의정부 무통치료 수면치과 |
| 24 | 소아치과 | `/pediatric-dental` | 의정부 소아치과 어린이 치과 |
| 25 | 크라운 | `/crown` | 의정부 크라운 지르코니아 |
| 26 | 치아미백 | `/teeth-whitening` | 의정부 치아미백 |
| 27 | 정기검진 | `/dental-checkup` | 치과 정기검진 구강검진 |
| 28 | 임플란트 과정 | `/implant-process` | 임플란트 과정 기간 단계 |
| 29 | 민락동 치과 | `/minrak-dental` | 민락동 치과 민락2지구 |

## SSR 페이지 (블로그/BA)
| Page | URL | Description |
|------|-----|-------------|
| 블로그 목록 | `/blog` | SSR 목록 + CollectionPage/ItemList JSON-LD + 페이지네이션 |
| 블로그 상세 | `/blog/:id` | SSR 상세 + BlogPosting JSON-LD + 전체 meta/OG |
| BA 목록 | `/before-after` | SSR 목록 + 카테고리 필터 + CollectionPage JSON-LD |
| BA 상세 | `/before-after/:id` | SSR 상세 + MedicalProcedure JSON-LD |

## Static 페이지 (12개)
메인(`/`), 진료안내(`/treatments`), 진료철학(`/philosophy`), 의료진(`/doctors`), 내원안내(`/guide`), FAQ(`/faq`), 공지사항(`/notice`), 백과사전(`/encyclopedia`), 예약(`/reservation`), 커뮤니티(`/community`), 회원가입(`/signup`), 관리자(`/admin`)

## SEO/AEO Features
- **26개 SSR 랜딩페이지** — MedicalWebPage + FAQPage + BreadcrumbList + Dentist JSON-LD
- **SSR Blog/BA** — BlogPosting + MedicalProcedure + CollectionPage JSON-LD
- **페이지별 OG 이미지 차별화** — 26개+ 카테고리별 다른 OG 이미지
- **llms.txt** — AI 검색엔진(ChatGPT, Perplexity) 최적화, 28개 서비스 + 40+ 키워드 매핑
- **IndexNow API** — 블로그/BA 생성·수정 시 Bing/Yandex 자동 제출
- **Sitemap Index** — 3개 분할 사이트맵 (pages/blog/BA), Image Sitemap 확장, 실제 lastmod 날짜
- **301 Redirects** — `blog-post.html?id=X` → `/blog/X`, `ba-post.html?id=X` → `/before-after/X`
- **Clean URLs** — 전체 사이트 .html 확장자 제거
- **SpeakableSpecification** — Google Voice Search 최적화
- **정확한 openingHoursSpecification** — 목요일 야간(20:30) 구분

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | 서버 상태 확인 |
| GET/POST | `/api/blogs` | 블로그 CRUD (+ IndexNow) |
| GET/POST | `/api/notices` | 공지사항 CRUD |
| GET/POST | `/api/before-after` | 비포애프터 CRUD (+ IndexNow) |
| POST | `/api/signup` | 회원가입 |
| POST | `/api/admin/login` | 관리자 로그인 |
| GET | `/sitemap.xml` | 사이트맵 인덱스 (3개 하위 사이트맵) |
| GET | `/sitemap-pages.xml` | 정적+랜딩 페이지 사이트맵 (41 URL, Image Sitemap) |
| GET | `/sitemap-blog.xml` | 블로그 사이트맵 (127 URL, Image Sitemap) |
| GET | `/sitemap-before-after.xml` | 비포&애프터 사이트맵 (83 URL, Image Sitemap) |
| GET | `/llms.txt` | AI 크롤러용 구조화 데이터 |

## Tech Stack
- **Backend**: Hono + Cloudflare Workers (Edge Runtime)
- **Frontend**: HTML5 + CSS3 + Vanilla JavaScript + Tailwind CSS (CDN)
- **Database**: Cloudflare D1 (SQLite) — `gaon-dental-db`
- **Storage**: Cloudflare R2 — `gaon-dental-images`
- **Build**: Vite + TypeScript
- **SEO**: JSON-LD (10+ schema types), IndexNow, llms.txt, Dynamic Sitemap

## Deployment
- **Platform**: Cloudflare Pages
- **Project**: seoulgaon-dental
- **Custom Domain**: seoulgaondc.kr
- **D1 Database**: gaon-dental-db
- **R2 Bucket**: gaon-dental-images
- **Status**: Production Live
- **Last Updated**: 2026-05-27

## Version History
- v12 (2026-05-27): Sitemap Pro — sitemap index split (3 sub-sitemaps), image sitemap, notice fragment removal, lastmod accuracy
- v11 (2026-05-26): SEO v4 — 6 new pages (pediatric, crown, whitening, checkup, implant-process, minrak), crosslinks
- v10 (2026-05-26): SEO v3 — 6 new landing pages, OG image differentiation, corrected opening hours
- v9 (2026-05-26): SEO v2 — 8 new landing pages, blog/BA list SSR, IndexNow, llms.txt expansion
- v8 (2026-05-26): SEO v1 — 6 landing pages, blog/BA SSR, clean URLs, 301 redirects
- v7 (2026-04-09): Full rebuild with Hono + D1 + R2
