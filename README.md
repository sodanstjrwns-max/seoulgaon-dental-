# 서울가온치과 공식 웹사이트

## Project Overview
- **Name**: 서울가온치과 (Seoul Gaon Dental Clinic)
- **Version**: v7 REBUILD
- **Type**: 정적(Static) 웹사이트 — HTML5 + CSS3 + Vanilla JS + GSAP 3.12
- **Target**: 의정부 서울가온치과의원 (현진호 대표원장)

## URLs
- **Preview**: [Sandbox URL]
- **Phone**: 0507-1325-3377
- **Instagram**: https://www.instagram.com/seoulgaondental
- **Blog**: https://blog.naver.com/stokgw1

## Pages (5)
| Page | File | Description |
|------|------|-------------|
| 메인 | `index.html` | Hero + 10개 섹션 (Philosophy, Treatments, Story, Doctors, Facility, FAQ, Reviews, Contact) |
| 진료 안내 | `treatments.html` | 임플란트, 앞니 심미치료, 신경치료 상세 |
| 블로그 | `blog.html` | 네이버 블로그 링크 카드 6개 |
| 비포 애프터 | `before-after.html` | 치료 전후 케이스 6개 (사진 준비 중) |
| 공지사항 | `notice.html` | 진료시간, 주차, 야간, 이벤트 5개 |

## Design System
- **Colors**: Dark ink (#050504) + Gold (#BFA46A) + Ivory (#F2EDE4)
- **Fonts**: Black Han Sans (제목) / Bebas Neue (영문) / Pretendard (본문)
- **Animations**: GSAP 3.12 — 메인 22개 모션, 서브 13개 모션

## Tech Stack
- **Backend**: Hono + Cloudflare Pages (정적 파일 서빙)
- **Frontend**: HTML5 + CSS3 + Vanilla JavaScript
- **Animation**: GSAP 3.12 + ScrollTrigger + ScrollToPlugin
- **Build**: Vite + TypeScript
- **Hosting**: Cloudflare Pages

## File Structure
```
public/
├── index.html              메인 페이지 (CSS 인라인)
├── treatments.html         진료 안내
├── blog.html               블로그
├── before-after.html       비포 애프터
├── notice.html             공지사항
├── style.css               서브페이지 공용 CSS
├── pages.css               서브페이지 전용 CSS
├── pages.js                서브페이지 전용 JS (13 motions)
├── js/
│   ├── main.js             메인 JS (22 motions)
│   ├── gsap.min.js         GSAP Core
│   ├── ScrollTrigger.min.js
│   └── ScrollToPlugin.min.js
└── images/                 이미지 20장
```

## Completed Features
- [x] 5페이지 완전 구현
- [x] 22개 메인 모션 (로더, 노이즈, 커서, 패럴랙스, 3D틸트 등)
- [x] 13개 서브 모션 (필터, 아코디언, 카드입장 등)
- [x] 반응형 (1100px / 768px / 480px)
- [x] 커스텀 커서 (데스크탑)
- [x] 모바일 햄버거 메뉴
- [x] FAQ 아코디언
- [x] 무한 스크롤 리뷰 캐러셀
- [x] 이미지 20장 AI 생성

## Deployment
- **Platform**: Cloudflare Pages
- **Status**: ✅ Development Active
- **Last Updated**: 2026-04-04
