/* ============================================================
   site.js — 서울가온치과 공용 크롬 (2026-11-05 슈퍼 리뉴얼)
   헤더 상태(스크롤 내리면 숨김) · 드로어 · 드롭다운 터치 · 실시간 진료 상태(KST) ·
   등장 연출(IntersectionObserver threshold 0 + 안전망) · 모바일 하단 바 · 진행선 · 앵커 부드러운 이동
   원칙: 글자는 전부 HTML 그대로. html.mx(동작 줄이기 아님 + IO 지원)일 때만 CSS 가 숨김 시작하고 여기서 드러낸다.
   하위페이지 pages.js 와 겹치는 드로어/드롭다운은 body.dataset.navBound / dropBound 로 한 번만 묶는다.
   ============================================================ */
(function () {
  'use strict';
  var d = document, w = window, html = d.documentElement;
  var $ = function (s, c) { return (c || d).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); };
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  var ICON = {
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.2-4.4A8 8 0 1 1 21 12z"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s7-6.3 7-12a7 7 0 0 0-14 0c0 5.7 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>'
  };

  // ── 헤더: 스크롤 상태 · 내리면 숨김/올리면 표시 · 진행선
  var nav = $('#nav'), lastY = w.scrollY || 0, ticking = false;
  function onScroll() {
    var y = w.scrollY;
    if (nav) {
      nav.classList.toggle('stuck', y > 8);
      if (!d.body.classList.contains('menu-open')) {
        if (y > lastY + 8 && y > 260) nav.classList.add('hide');
        else if (y < lastY - 8 || y < 120) nav.classList.remove('hide');
      }
    }
    var bar = $('#progressBar');
    if (bar) { var h = html.scrollHeight - w.innerHeight; bar.style.width = (h > 0 ? (y / h * 100) : 0) + '%'; }
    lastY = y; ticking = false;
  }
  w.addEventListener('scroll', function () { if (!ticking) { requestAnimationFrame(onScroll); ticking = true; } }, { passive: true });
  onScroll();

  // ── 드로어 (한 번만)
  var btn = $('.hamburger'), menu = $('.mob-menu');
  function setMenu(open) {
    if (!btn || !menu) return;
    btn.classList.toggle('open', open);
    menu.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? '메뉴 닫기' : '메뉴 열기');
    d.body.classList.toggle('menu-open', open);
    d.body.style.overflow = open ? 'hidden' : '';
    if (open && nav) nav.classList.remove('hide');
  }
  if (btn && menu && !d.body.dataset.navBound) {
    d.body.dataset.navBound = '1';
    btn.addEventListener('click', function () { setMenu(!menu.classList.contains('open')); });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menu.classList.contains('open')) setMenu(false); });
    w.addEventListener('resize', function () { if (w.innerWidth > 900 && menu.classList.contains('open')) setMenu(false); });
  }

  // ── 드롭다운: 터치 기기는 첫 탭에 열고 두 번째 탭에 이동
  if (!d.body.dataset.dropBound) {
    d.body.dataset.dropBound = '1';
    var coarse = matchMedia('(hover: none)').matches;
    $$('.nav-link-drop').forEach(function (wrap) {
      var a = wrap.querySelector(':scope > a');
      if (!a) return;
      a.addEventListener('click', function (e) {
        if (!coarse) return;
        if (!wrap.classList.contains('touch-open')) {
          e.preventDefault();
          $$('.nav-link-drop.touch-open').forEach(function (o) { if (o !== wrap) o.classList.remove('touch-open'); });
          wrap.classList.add('touch-open');
        }
      });
    });
    d.addEventListener('click', function (e) {
      if (!e.target.closest('.nav-link-drop')) $$('.nav-link-drop.touch-open').forEach(function (o) { o.classList.remove('touch-open'); });
    });
  }

  // ── 실시간 진료 상태 (KST) — 월~금 09:30–18:30(목 20:30) · 점심 12:30–14:00 · 토 09:30–14:00 · 일 휴진
  var HOURS = { 1: [9.5, 18.5], 2: [9.5, 18.5], 3: [9.5, 18.5], 4: [9.5, 20.5], 5: [9.5, 18.5], 6: [9.5, 14] };
  var LUNCH = [12.5, 14];
  function fmt(h) { var hh = Math.floor(h), mm = Math.round((h - hh) * 60); return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm; }
  function kst() { var t = new Date(Date.now() + 9 * 3600000); return { day: t.getUTCDay(), now: t.getUTCHours() + t.getUTCMinutes() / 60 }; }
  function status() {
    var k = kst(), hh = HOURS[k.day];
    if (!hh) return { cls: 'is-closed', txt: '오늘 휴진 · 일요일' };
    if (k.now < hh[0]) return { cls: 'is-before', txt: '오늘 ' + fmt(hh[0]) + ' 진료 시작' };
    if (k.day !== 6 && k.now >= LUNCH[0] && k.now < LUNCH[1]) return { cls: 'is-lunch', txt: '점심시간 · ' + fmt(LUNCH[1]) + ' 재개' };
    if (k.now < hh[1]) return { cls: 'is-open', txt: '지금 진료중 · ' + fmt(hh[1]) + '까지' };
    return { cls: 'is-closed', txt: '오늘 진료 종료' };
  }
  if (nav && !nav.querySelector('[data-status]')) {
    var pill = d.createElement('span');
    pill.className = 'live-pill'; pill.setAttribute('data-status', ''); pill.setAttribute('role', 'status'); pill.setAttribute('aria-live', 'polite');
    pill.innerHTML = '<i></i><span class="txt"></span>';
    var ref = nav.querySelector('.nav-member') || nav.querySelector('.nav-cta') || nav.querySelector('.hamburger');
    nav.insertBefore(pill, ref || null);
  }
  function tick() {
    var s = status();
    $$('[data-status]').forEach(function (el) {
      el.classList.remove('is-open', 'is-lunch', 'is-before', 'is-closed');
      el.classList.add(s.cls);
      var t = el.querySelector('.txt'); if (t) t.textContent = s.txt;
    });
  }
  tick(); setInterval(tick, 30000);

  // ── 등장 연출: threshold 0 (뷰포트보다 큰 격자도 영구 숨김 없음)
  //    + 스크롤마다 "뷰포트 아래쪽 경계 위에 있는" 요소는 전부 드러냄(앵커·빠른 점프로 지나친 요소 영구 숨김 방지)
  //    + 2.5초 안전망(첫 화면 안 요소 강제 표시)
  if (html.classList.contains('mx')) {
    var pending = $$('[data-reveal]');
    function reveal(el) { el.classList.add('revealed'); }
    function sweep() {
      if (!pending.length) return;
      var limit = w.innerHeight * 0.94;
      pending = pending.filter(function (el) {
        var r = el.getBoundingClientRect();
        if (r.top < limit) { reveal(el); return false; }
        return true;
      });
    }
    if ('IntersectionObserver' in w) {
      var io = new IntersectionObserver(function (en) {
        en.forEach(function (e) { if (e.isIntersecting) { reveal(e.target); io.unobserve(e.target); } });
      }, { threshold: 0, rootMargin: '0px 0px -6% 0px' });
      pending.forEach(function (el) { io.observe(el); });
    } else {
      pending.forEach(reveal); pending = [];
    }
    var sweeping = false;
    w.addEventListener('scroll', function () { if (!sweeping) { sweeping = true; requestAnimationFrame(function () { sweep(); sweeping = false; }); } }, { passive: true });
    setTimeout(sweep, 2500);
    setTimeout(function () { html.classList.add('mx-done'); }, 4500);
  }

  // ── 모바일 하단 바 (전화 · 카카오 · 네이버 예약 · 오시는 길)
  if (!$('.mcta') && location.pathname.indexOf('/admin') !== 0) {
    var bar = d.createElement('nav');
    bar.className = 'mcta'; bar.setAttribute('aria-label', '빠른 연락');
    bar.innerHTML =
      '<a href="tel:0507-1325-3377">' + ICON.phone + '전화</a>' +
      '<a href="https://pf.kakao.com/_LLxhwG/chat" target="_blank" rel="noopener">' + ICON.chat + '카카오톡</a>' +
      '<a class="primary" href="https://booking.naver.com/booking/13/bizes/781025" target="_blank" rel="noopener">' + ICON.cal + '네이버 예약</a>' +
      '<a href="/guide#visit">' + ICON.pin + '오시는 길</a>';
    d.body.appendChild(bar);
  }

  // ── 앵커 부드러운 이동 (scroll-margin-top 은 CSS)
  d.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a || a.getAttribute('href').length < 2) return;
    var t = d.getElementById(a.getAttribute('href').slice(1));
    if (!t) return;
    e.preventDefault();
    t.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    if (history.replaceState) history.replaceState(null, '', a.getAttribute('href'));
  });

  // ── 페이지 미리 받기 (2026-11-06) — 메뉴·카드를 누르기 직전에 다음 페이지 HTML 을 받아 둬 이동이 바로 열린다.
  //    크롬·엣지·삼성 인터넷: Speculation Rules(마우스를 올리거나 누르기 시작할 때).
  //    사파리 등: 손가락이 닿거나 마우스가 올라가면 한 번만 받아 둔다(HTML 은 브라우저 캐시 1시간).
  //    데이터 절약 모드면 하지 않는다. 관리자·API·새 창·다운로드 링크는 제외.
  (function () {
    var conn = navigator.connection || {};
    if (conn.saveData || /2g$/.test(conn.effectiveType || '')) return;
    try {
      if (w.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) {
        var sr = d.createElement('script');
        sr.type = 'speculationrules';
        sr.textContent = JSON.stringify({ prefetch: [{ source: 'document', eagerness: 'moderate', where: { and: [
          { href_matches: '/*' },
          { not: { href_matches: ['/admin*', '/api/*', '/*.xml', '/*.txt'] } },
          { not: { selector_matches: '[target=_blank],[download],[rel~=nofollow]' } }
        ] } }] });
        d.head.appendChild(sr);
        return;
      }
    } catch (e) { /* 지원 안 함 → 아래 방식 */ }
    var warmed = {};
    function warm(e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      var u; try { u = new URL(a.href, location.href); } catch (er) { return; }
      if (u.origin !== location.origin || /^\/(admin|api)(\/|$)/.test(u.pathname) || /\.(xml|txt|pdf|jpe?g|png|webp|mp4)$/i.test(u.pathname)) return;
      if (u.pathname === location.pathname && u.search === location.search) return;
      var k = u.pathname + u.search;
      if (warmed[k]) return;
      warmed[k] = 1;
      var l = d.createElement('link');
      if (l.relList && l.relList.supports && l.relList.supports('prefetch')) { l.rel = 'prefetch'; l.href = k; d.head.appendChild(l); }
      else if (w.fetch) fetch(k, { credentials: 'same-origin' }).catch(function () {});
    }
    d.addEventListener('touchstart', warm, { passive: true, capture: true });
    d.addEventListener('mouseover', warm, { passive: true, capture: true });
  })();
})();
