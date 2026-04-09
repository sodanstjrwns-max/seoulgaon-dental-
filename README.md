# 서울가온치과 공식 웹사이트

## Project Overview
- **Name**: 서울가온치과 (Seoul Gaon Dental Clinic)
- **Version**: v7 REBUILD — Production Deployed
- **Type**: Hono + Cloudflare Pages (SSR + Static) — D1 Database + R2 Storage
- **Target**: 의정부 서울가온치과의원 (현진호 대표원장)

## URLs
- **Production**: https://seoulgaon-dental.pages.dev
- **GitHub**: https://github.com/sodanstjrwns-max/seoulgaon-dental-
- **Phone**: 0507-1325-3377
- **Instagram**: https://www.instagram.com/seoulgaondental
- **Blog**: https://blog.naver.com/stokgw1

## Pages (12)
| Page | URL Path | Description |
|------|----------|-------------|
| 메인 | `/` | Hero + 10개 섹션 (Philosophy, Treatments, Story, Doctors, Facility, FAQ, Reviews, Contact) |
| 진료 안내 | `/treatments` | 임플란트, 앞니 심미치료, 신경치료 + 일반진료 12개 모달(각 15개 FAQ) |
| 진료 철학 | `/philosophy` | 치료 철학, 원장 소개, 감염관리 체계 |
| 의료진 | `/doctors` | 의료진 프로필, 학력·경력, 전문 분야 |
| 내원 안내 | `/guide` | 오시는 길, 진료비, 주차 안내 |
| FAQ | `/faq` | 60개 FAQ (8개 카테고리), 검색·필터 기능 |
| 블로그 | `/blog` | 네이버 블로그 링크 카드 |
| 공지사항 | `/notice` | 진료시간, 주차, 야간, 이벤트 |
| 치과 백과사전 | `/encyclopedia` | 임플란트, 신경치료, 크라운 등 용어 설명 |
| 비포 애프터 | `/before-after` | 치료 전후 케이스 |
| 회원가입 | `/signup` | 상담 예약 및 회원가입 |
| 관리자 | `/admin` | 콘텐츠 관리 대시보드 (블로그, 공지, 비포애프터, 회원) |

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | 서버 상태 확인 |
| GET | `/api/blogs` | 블로그 목록 조회 |
| POST | `/api/blogs` | 블로그 생성 |
| GET | `/api/notices` | 공지사항 목록 조회 |
| POST | `/api/notices` | 공지사항 생성 |
| GET | `/api/before-after` | 비포애프터 목록 |
| POST | `/api/before-after` | 비포애프터 생성 |
| POST | `/api/signup` | 회원가입 |
| POST | `/api/admin/login` | 관리자 로그인 |

## Design System
- **Colors**: Dark ink (#050504) + Gold (#BFA46A) + Ivory (#F2EDE4)
- **Fonts**: Black Han Sans (제목) / Bebas Neue (영문) / Pretendard (본문)
- **Animations**: GSAP 3.12 — 메인 22개 모션, 서브 13개 모션

## Tech Stack
- **Backend**: Hono + Cloudflare Workers (Edge Runtime)
- **Frontend**: HTML5 + CSS3 + Vanilla JavaScript + Tailwind CSS (CDN)
- **Animation**: GSAP 3.12 + ScrollTrigger + ScrollToPlugin
- **Database**: Cloudflare D1 (SQLite) — `gaon-dental-db`
- **Storage**: Cloudflare R2 — `gaon-dental-images`
- **Build**: Vite + TypeScript
- **Hosting**: Cloudflare Pages
- **Icons**: Font Awesome 6.4

## File Structure
```
webapp/
├── src/
│   └── index.tsx              Hono 메인 앱 (라우팅 + API)
├── public/
│   ├── index.html             메인 페이지
│   ├── treatments.html        진료 안내 (180개 FAQ 포함)
│   ├── philosophy.html        진료 철학
│   ├── doctors.html           의료진 소개
│   ├── guide.html             내원 안내
│   ├── faq.html               FAQ (60개, JSON-LD 스키마)
│   ├── blog.html              블로그
│   ├── notice.html            공지사항
│   ├── encyclopedia.html      치과 백과사전
│   ├── before-after.html      비포 애프터
│   ├── signup.html            회원가입
│   ├── admin.html             관리자 대시보드
│   ├── style.css              공용 CSS
│   ├── pages.css              서브페이지 전용 CSS
│   ├── pages.js               서브페이지 전용 JS
│   ├── js/                    GSAP 라이브러리
│   └── images/                이미지 에셋
├── migrations/
│   └── 0001_initial.sql       D1 초기 스키마
├── wrangler.jsonc             Cloudflare 설정
├── vite.config.ts             빌드 설정
├── ecosystem.config.cjs       PM2 설정
└── package.json
```

## Completed Features
- [x] 12페이지 완전 구현 + 관리자 대시보드
- [x] D1 데이터베이스 연동 (회원, 블로그, 공지, 비포애프터)
- [x] R2 이미지 스토리지 연동
- [x] 22개 메인 모션 (로더, 노이즈, 커서, 패럴랙스, 3D틸트 등)
- [x] 13개 서브 모션 (필터, 아코디언, 카드입장 등)
- [x] 반응형 (1100px / 768px / 480px)
- [x] 커스텀 커서 (데스크탑)
- [x] 모바일 햄버거 메뉴 + 하단 시트 모달
- [x] FAQ 60개 (8개 카테고리) + JSON-LD 스키마
- [x] 진료 모달 180개 FAQ (12개 일반진료 × 15개)
- [x] 무한 스크롤 리뷰 캐러셀
- [x] Font Awesome 아이콘 전 페이지 적용
- [x] Lazy loading 이미지 최적화
- [x] SEO 메타태그 + Open Graph + JSON-LD
- [x] Cloudflare Pages 프로덕션 배포 완료
- [x] GitHub 리포지토리 연동

## Deployment
- **Platform**: Cloudflare Pages
- **Project**: seoulgaon-dental
- **Production URL**: https://seoulgaon-dental.pages.dev
- **D1 Database**: gaon-dental-db (db1ede33-48e6-47d3-903e-bf5173191773)
- **R2 Bucket**: gaon-dental-images
- **Status**: ✅ Production Live
- **Last Updated**: 2026-04-09
