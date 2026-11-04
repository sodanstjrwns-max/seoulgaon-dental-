/* ============================================================
   home.js — 서울가온치과 홈 연출 (2026-11-05 슈퍼 리뉴얼)
   GSAP 3.12 + ScrollTrigger (로컬 /js). 섹션 pin 없음(CLS), 이동은 transform 만, 글자 분할 없음.
   html.mx(동작 줄이기 아님 + IO 지원)일 때만 연출. GSAP 이 없으면 mx 를 떼어 정적으로 보여준다.
   ============================================================ */
(function () {
  'use strict';
  var d = document, w = window, html = d.documentElement;
  var $ = function (s, c) { return (c || d).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); };

  // ── 공간 사진 스크롤러 버튼 (연출과 무관 — 항상)
  var sc = $('.fac-scroller');
  $$('.fac-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!sc) return;
      var dir = +b.getAttribute('data-dir') || 1;
      var item = sc.querySelector('.fac-item');
      var step = item ? item.getBoundingClientRect().width + 16 : 360;
      sc.scrollBy({ left: dir * step, behavior: 'smooth' });
    });
  });

  var mx = html.classList.contains('mx');
  function done() { html.classList.add('mx-done'); }
  if (!mx) return;
  if (!w.gsap || !w.ScrollTrigger) { html.classList.remove('mx'); done(); return; }
  gsap.registerPlugin(ScrollTrigger);

  // ── 1) 히어로 인트로: 아치가 열리고, 글이 떠오르고, 빛의 고리가 드러난다
  var copy = $$('.hero-copy > *'), arch = $('.hero-arch'), stats = $('.hero-stats'), ring = $('.hero-ring');
  var ARCH_FROM = 'inset(34% 14% 0% 14% round 999px 999px 18px 18px)';
  var ARCH_TO = 'inset(0% 0% 0% 0% round 999px 999px 18px 18px)';
  var intro = gsap.timeline({
    defaults: { ease: 'power3.out' },
    onComplete: function () {
      done();
      gsap.set(copy.concat([arch, stats, ring]).filter(Boolean), { clearProps: 'opacity,transform,clipPath' });
    }
  });
  if (arch) intro.fromTo(arch, { clipPath: ARCH_FROM }, { clipPath: ARCH_TO, duration: 1.5, ease: 'power4.inOut' }, 0);
  if (copy.length) intro.fromTo(copy, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: .9, stagger: .09 }, .3);
  if (ring) intro.fromTo(ring, { opacity: 0 }, { opacity: 1, duration: 1.2 }, .6);
  if (stats) intro.fromTo(stats, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: .8 }, .95);
  // 안전망: 3.5초 뒤에도 인트로가 안 끝났으면(백그라운드 탭 등) 끝 상태로 보내 글자를 드러낸다
  setTimeout(function () { if (intro.isActive() || intro.progress() < 1) intro.progress(1); done(); }, 3500);

  // ── 2) 히어로 시차 (transform 만, 사진은 112% 높이로 여유)
  var heroImg = $('.hero-arch img');
  if (heroImg) gsap.fromTo(heroImg, { yPercent: -6 }, { yPercent: 0, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
  if (ring) gsap.to(ring, { rotate: 48, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

  // ── 3) 세 가지 핵심 진료: 지나가는 패널 ↔ 좌측 색인
  var panels = $$('.tx-panel'), idx = $$('.tx-index li');
  panels.forEach(function (p, i) {
    ScrollTrigger.create({
      trigger: p, start: 'top 58%', end: 'bottom 42%',
      onToggle: function (st) {
        if (!st.isActive) return;
        panels.forEach(function (x) { x.classList.toggle('active', x === p); });
        idx.forEach(function (li, j) { li.classList.toggle('active', j === i); });
      }
    });
  });
  if (panels[0]) panels[0].classList.add('active');
  if (idx[0]) idx[0].classList.add('active');
  idx.forEach(function (li, i) {
    li.addEventListener('click', function () { if (panels[i]) panels[i].scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  });

  // ── 4) 이야기 사진 시차
  var storyImg = $('.story-photo img');
  if (storyImg) gsap.fromTo(storyImg, { yPercent: -7 }, { yPercent: 0, ease: 'none', scrollTrigger: { trigger: '.story', start: 'top bottom', end: 'bottom top', scrub: true } });

  // ── 5) 설명이 먼저: 문장 덩어리가 차례로 켜지고, 사진은 천천히 제자리로
  var phs = $$('.consult-quote .ph');
  if (phs.length) {
    ScrollTrigger.create({
      trigger: '.consult-text', start: 'top 80%', end: 'center 50%', scrub: true,
      onUpdate: function (st) {
        var n = st.progress >= .97 ? phs.length : Math.floor(st.progress * (phs.length + 1));
        phs.forEach(function (p, i) { p.classList.toggle('lit', i < n); });
      }
    });
  }
  var cImg = $('.consult-img img');
  if (cImg) gsap.fromTo(cImg, { scale: 1.1 }, { scale: 1, ease: 'none', scrollTrigger: { trigger: '.consult', start: 'top bottom', end: 'bottom top', scrub: true } });

  // ── 6) 숫자 세기
  $$('[data-count]').forEach(function (el) {
    var to = +el.getAttribute('data-count') || 0, o = { v: 0 };
    ScrollTrigger.create({
      trigger: el, start: 'top 92%', once: true,
      onEnter: function () { gsap.to(o, { v: to, duration: 1.4, ease: 'power2.out', onUpdate: function () { el.textContent = Math.round(o.v); } }); }
    });
  });

  // 서체 로드·이미지 로드 뒤 트리거 위치 재계산
  if (d.fonts && d.fonts.ready) d.fonts.ready.then(function () { ScrollTrigger.refresh(); });
  w.addEventListener('load', function () { ScrollTrigger.refresh(); });
})();
