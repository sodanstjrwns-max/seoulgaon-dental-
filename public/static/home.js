/* ============================================================
   home.js — 서울가온치과 홈 연출 v3 "기억의 문" (2026-11-05)
   GSAP 3.12 + ScrollTrigger + Lenis(마우스/트랙패드만) — 전부 로컬 /js.
   고정은 CSS sticky, GSAP pin 없음(CLS). 이동은 transform/clip-path/opacity 만. 글자 분할 없음(의미 단위 .ph 만).
   html.mx(동작 줄이기 아님 + IO)일 때만 연출. GSAP 이 없거나 예외가 나면 mx 를 떼어 정적으로 보여준다.
   ============================================================ */
(function () {
  'use strict';
  var d = document, w = window, html = d.documentElement;
  var $ = function (s, c) { return (c || d).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); };
  var fine = matchMedia('(pointer: fine)').matches;
  var nav = $('#nav');

  // ── 헤더 밤/낮 전환 (연출과 무관 — 항상)
  var themed = $$('[data-theme]');
  function navTheme() {
    if (!nav || !themed.length) return;
    var y = (nav.offsetHeight || 70) * 0.6, cur = 'day';
    for (var i = 0; i < themed.length; i++) {
      var r = themed[i].getBoundingClientRect();
      if (r.top <= y && r.bottom > y) { cur = themed[i].getAttribute('data-theme'); break; }
    }
    nav.classList.toggle('on-night', cur === 'night');
  }
  var navTick = false;
  w.addEventListener('scroll', function () { if (!navTick) { navTick = true; requestAnimationFrame(function () { navTheme(); navTick = false; }); } }, { passive: true });
  w.addEventListener('resize', navTheme);
  navTheme();

  // ── 공간 레일: 손으로 넘기는 모드(모바일·연출 없음) 버튼
  var scroller = $('.fac-scroller');
  function touchRail(on) {
    if (!scroller) return;
    scroller.classList.toggle('touch', !!on);
    var nv = $('.fac-nav'); if (nv) nv.classList.toggle('hide', !on);
  }
  $$('.fac-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!scroller) return;
      var dir = +b.getAttribute('data-dir') || 1;
      var item = scroller.querySelector('.fac-item');
      var step = item ? item.getBoundingClientRect().width + 20 : 360;
      scroller.scrollBy({ left: dir * step, behavior: 'smooth' });
    });
  });

  var mx = html.classList.contains('mx');
  function done() { html.classList.add('mx-done'); }
  function introDone() { html.classList.add('intro-done'); }
  function bail(err) {
    html.classList.remove('mx'); introDone(); done(); touchRail(true);
    var c = $('.curtain'); if (c) c.remove();
    if (err && w.console) console.error('[home.js]', err);
  }
  if (!mx) { introDone(); done(); touchRail(true); return; }
  if (!w.gsap || !w.ScrollTrigger) { bail(); return; }
  try { main(); } catch (e) { bail(e); }

  function main() {
    gsap.registerPlugin(ScrollTrigger);
    var mm = gsap.matchMedia();

    // ── 1) 관성 스크롤 (마우스·트랙패드만, 터치는 기본 스크롤)
    var lenis = null;
    if (fine && w.Lenis) {
      lenis = new Lenis({ duration: 1.15, smoothWheel: true, wheelMultiplier: 0.95 });
      lenis.on('scroll', ScrollTrigger.update);
      gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
      gsap.ticker.lagSmoothing(0);
      d.addEventListener('click', function (e) {
        var a = e.target.closest('a[href^="#"]');
        if (!a || a.getAttribute('href').length < 2) return;
        var t = d.getElementById(a.getAttribute('href').slice(1));
        if (!t) return;
        e.preventDefault(); e.stopImmediatePropagation();
        lenis.scrollTo(t, { offset: -((nav ? nav.offsetHeight : 0) + 8), duration: 1.4 });
        if (history.replaceState) history.replaceState(null, '', a.getAttribute('href'));
      }, true);
      // 드로어가 열리면 멈춤
      new MutationObserver(function () { d.body.classList.contains('menu-open') ? lenis.stop() : lenis.start(); }).observe(d.body, { attributes: true, attributeFilter: ['class'] });
    }

    // ── 2) 커서 (마우스만)
    if (fine) {
      var cur = d.createElement('div'), ring = d.createElement('div');
      cur.className = 'cur off'; ring.className = 'cur-ring off'; ring.innerHTML = '<span class="cur-txt"></span>';
      d.body.appendChild(cur); d.body.appendChild(ring);
      html.classList.add('has-cursor');
      var mx_ = -100, my_ = -100, rx = -100, ry = -100, shown = false;
      d.addEventListener('pointermove', function (e) {
        mx_ = e.clientX; my_ = e.clientY;
        if (!shown) { shown = true; rx = mx_; ry = my_; cur.classList.remove('off'); ring.classList.remove('off'); }
      }, { passive: true });
      d.addEventListener('pointerleave', function () { cur.classList.add('off'); ring.classList.add('off'); shown = false; });
      d.addEventListener('pointerdown', function () { ring.style.transform = 'translate(-50%,-50%) scale(.85)'; });
      d.addEventListener('pointerup', function () { ring.style.transform = ''; });
      gsap.ticker.add(function () {
        rx += (mx_ - rx) * 0.18; ry += (my_ - ry) * 0.18;
        cur.style.left = mx_ + 'px'; cur.style.top = my_ + 'px';
        ring.style.left = rx + 'px'; ring.style.top = ry + 'px';
      });
      var txt = ring.querySelector('.cur-txt');
      d.addEventListener('pointerover', function (e) {
        var lbl = e.target.closest('[data-cursor]');
        if (lbl) { txt.textContent = lbl.getAttribute('data-cursor') || 'VIEW'; ring.classList.add('lbl'); ring.classList.remove('on'); return; }
        var hot = e.target.closest('a,button,summary,label,[role="button"]');
        ring.classList.toggle('on', !!hot); ring.classList.remove('lbl');
      });
    }

    // ── 3) 커튼 + 히어로 인트로
    var curtain = $('.curtain');
    var heroCopy = { lines: $$('.hero-h .ln > .ph'), kicker: $('.hero-kicker'), subs: $$('.hero-sub .ph'), btns: $('.hero-btns'), foot: $('.hero-foot'), meta: $('.hero-meta') };
    gsap.set(heroCopy.lines, { yPercent: 112 });
    gsap.set([heroCopy.kicker, heroCopy.btns, heroCopy.foot, heroCopy.meta].filter(Boolean), { opacity: 0 });
    gsap.set(heroCopy.subs, { opacity: 0, y: 12 });
    var heroTl = gsap.timeline({
      paused: true, defaults: { ease: 'power4.out' },
      onComplete: function () { gsap.set(heroCopy.lines.concat(heroCopy.subs, [heroCopy.kicker, heroCopy.btns, heroCopy.foot, heroCopy.meta]).filter(Boolean), { clearProps: 'opacity,transform' }); }
    });
    heroTl.to(heroCopy.lines, { yPercent: 0, duration: 1.4, stagger: 0.13 }, 0)
      .to(heroCopy.kicker, { opacity: 1, duration: 0.9 }, 0.25)
      .to(heroCopy.subs, { opacity: 1, y: 0, duration: 1, stagger: 0.11 }, 0.7)
      .to(heroCopy.btns, { opacity: 1, duration: 0.9 }, 1.0)
      .to(heroCopy.foot, { opacity: 1, duration: 1 }, 1.15)
      .to(heroCopy.meta, { opacity: 1, duration: 1 }, 1.2);

    var seen = false;
    try { seen = sessionStorage.getItem('sg-intro') === '1'; } catch (e) { /* 비공개 모드 */ }
    if (!curtain || seen) {
      if (curtain) curtain.remove();
      introDone(); heroTl.play();
    } else {
      try { sessionStorage.setItem('sg-intro', '1'); } catch (e) { /* ignore */ }
      var ctl = gsap.timeline({ onComplete: function () { introDone(); curtain.remove(); } });
      ctl.to('.curtain-mark', { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, 0)
        .to('.curtain-sub', { opacity: 1, duration: 0.7 }, 0.3)
        .to('.curtain-line b', { scaleX: 1, duration: 1.0, ease: 'power2.inOut' }, 0.15)
        .to('.curtain-in', { y: -28, opacity: 0, duration: 0.5, ease: 'power2.in' }, 1.15)
        .to(curtain, { clipPath: 'inset(0 0 100% 0)', duration: 1.05, ease: 'power4.inOut' }, 1.3)
        .add(function () { heroTl.play(); }, 1.5);
    }
    // 안전망: 4초 뒤에도 안 끝났으면(백그라운드 탭 등) 끝 상태로
    setTimeout(function () {
      var c = $('.curtain'); if (c) c.remove();
      introDone();
      if (heroTl.progress() < 1) heroTl.progress(1);
    }, 4000);

    // 히어로가 밀려 올라가며 글이 가라앉고 사진은 느리게
    var heroIn = $('.hero-in'), heroBg = $('.hero-bg img');
    if (heroIn) gsap.to(heroIn, { yPercent: -16, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
    if (heroBg) gsap.to(heroBg, { yPercent: 10, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

    // ── 4) 문(GATE): 아치가 열리고, 주변이 밝아지고, 글이 바뀐다
    var gate = $('.gate'), arch = $('.gate-arch'), archImg = $('.gate-arch img'), paper = $('.gate-paper'), glow = $('.gate-glow'), shade = $('.gate-shade'),
      open = $('.gate-open'), tick = $('.gate-tick'), gcopy = $('.gate-copy');
    if (gate && arch) {
      gsap.set(arch, { clipPath: 'inset(56% 41% 0% 41% round 999px 999px 0px 0px)' });
      gsap.set(archImg, { scale: 1.35 });
      gsap.set(paper, { opacity: 0 });
      gsap.set(glow, { opacity: 0 });
      gsap.set(shade, { opacity: 0 });
      gsap.set(gcopy, { opacity: 0, y: 36 });
      var gtl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: gate, start: 'top top', end: function () { return '+=' + (gate.offsetHeight - w.innerHeight); }, scrub: 0.5, invalidateOnRefresh: true,
          onUpdate: function (st) {
            var th = st.progress > 0.6 ? 'day' : 'night';
            if (gate.getAttribute('data-theme') !== th) { gate.setAttribute('data-theme', th); navTheme(); }
          }
        }
      });
      gtl.fromTo(open, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.1 }, 0)
        .fromTo(tick, { opacity: 0 }, { opacity: 1, duration: 0.1 }, 0.02)
        .to(arch, { clipPath: 'inset(0% 0% 0% 0% round 0px 0px 0px 0px)', duration: 0.6, ease: 'power2.inOut' }, 0.12)
        .to(archImg, { scale: 1, duration: 0.78 }, 0.1)
        .to([open, tick], { opacity: 0, y: -50, duration: 0.16 }, 0.3)
        .to(glow, { opacity: 1, duration: 0.18 }, 0.26)
        .to(paper, { opacity: 1, duration: 0.3 }, 0.34)
        .to(glow, { opacity: 0, duration: 0.22 }, 0.5)
        .to(shade, { opacity: 1, duration: 0.14 }, 0.7)
        .to(gcopy, { opacity: 1, y: 0, duration: 0.18 }, 0.76);
    }

    // ── 5) 진료 원칙 6: 살짝 기울어 일어선다
    var cards = $$('.value-card');
    if (cards.length) gsap.from(cards, { opacity: 0, y: 44, rotateX: 10, transformOrigin: '50% 100%', duration: 1.1, stagger: 0.08, ease: 'power3.out', scrollTrigger: { trigger: '.values', start: 'top 85%', once: true } });

    // ── 6) 세 가지 핵심 진료 — PC: 가로 무대 / 모바일: 세로 등장
    mm.add('(min-width: 901px)', function () {
      var track = $('.tx-track'), panels = $$('.tx-panel'), bar = $('.tx-bar b'), curNum = $('.tx-cur');
      if (!track || panels.length < 2) return;
      var drive = gsap.to(track, {
        xPercent: -100 * (panels.length - 1) / panels.length, ease: 'none',
        scrollTrigger: {
          trigger: '.tx-stage', start: 'top top', end: function () { var s = $('.tx-stage'); return '+=' + (s.offsetHeight - w.innerHeight); }, scrub: 0.7, invalidateOnRefresh: true,
          onUpdate: function (st) {
            var p = st.progress;
            if (bar) bar.style.transform = 'scaleX(' + p + ')';
            var i = Math.min(panels.length - 1, Math.round(p * (panels.length - 1)));
            if (curNum) curNum.textContent = ('0' + (i + 1)).slice(-2);
          }
        }
      });
      panels.forEach(function (p) {
        var num = $('.tx-num', p), img = $('.tx-photo img', p), body = $('.tx-body', p);
        if (num) gsap.fromTo(num, { xPercent: 28 }, { xPercent: -28, ease: 'none', scrollTrigger: { containerAnimation: drive, trigger: p, start: 'left right', end: 'right left', scrub: true } });
        if (img) gsap.fromTo(img, { yPercent: -8 }, { yPercent: 0, ease: 'none', scrollTrigger: { containerAnimation: drive, trigger: p, start: 'left right', end: 'right left', scrub: true } });
        if (body) gsap.fromTo(body, { x: 60, opacity: 0.2 }, { x: 0, opacity: 1, ease: 'power2.out', scrollTrigger: { containerAnimation: drive, trigger: p, start: 'left 80%', end: 'left 20%', scrub: true } });
      });
    });
    mm.add('(max-width: 900px)', function () {
      $$('.tx-panel').forEach(function (p) {
        gsap.from(p, { opacity: 0, y: 40, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: p, start: 'top 85%', once: true } });
      });
    });

    // ── 7) 의정부 카드: 차례로 일어선다 (마크업 불변 — class 만)
    $$('.ub-cards li').forEach(function (li) {
      ScrollTrigger.create({ trigger: li, start: 'top 92%', once: true, onEnter: function () { li.classList.add('in'); } });
    });

    // ── 8) 이야기: 사진이 아래에서 열리고, 천천히 흐른다
    var sPhoto = $('.story-photo'), sImg = $('.story-photo img'), sBg = $('.story-bg-text'), sHead = $('.story-headline');
    if (sPhoto) {
      gsap.set(sPhoto, { clipPath: 'inset(0% 0% 100% 0% round 999px 999px 18px 18px)' });
      gsap.to(sPhoto, { clipPath: 'inset(0% 0% 0% 0% round 999px 999px 18px 18px)', duration: 1.5, ease: 'power4.inOut', scrollTrigger: { trigger: sPhoto, start: 'top 80%', once: true } });
    }
    if (sImg) gsap.fromTo(sImg, { yPercent: -9 }, { yPercent: 0, ease: 'none', scrollTrigger: { trigger: '.story', start: 'top bottom', end: 'bottom top', scrub: true } });
    if (sBg) gsap.fromTo(sBg, { xPercent: 8 }, { xPercent: -8, ease: 'none', scrollTrigger: { trigger: '.story', start: 'top bottom', end: 'bottom top', scrub: true } });
    if (sHead) gsap.from($$('.ph', sHead), { opacity: 0, y: 30, duration: 1.1, stagger: 0.14, ease: 'power3.out', scrollTrigger: { trigger: sHead, start: 'top 85%', once: true } });

    // ── 9) 설명이 먼저: 사진은 제자리로, 문장은 지나가며 켜지고, 숫자는 센다
    var cImg = $('.consult-img img');
    if (cImg) gsap.fromTo(cImg, { scale: 1.18 }, { scale: 1, ease: 'none', scrollTrigger: { trigger: '.consult', start: 'top bottom', end: 'bottom top', scrub: true } });
    var phs = $$('.consult-quote .ph');
    if (phs.length) ScrollTrigger.create({
      trigger: '.consult-text', start: 'top 75%', end: 'top 25%', scrub: true,
      onUpdate: function (st) {
        var n = st.progress >= 0.96 ? phs.length : Math.floor(st.progress * (phs.length + 1));
        phs.forEach(function (p, i) { p.classList.toggle('lit', i < n); });
      }
    });
    $$('[data-count]').forEach(function (el) {
      var to = +el.getAttribute('data-count') || 0, o = { v: 0 };
      ScrollTrigger.create({
        trigger: el, start: 'top 92%', once: true,
        onEnter: function () { gsap.to(o, { v: to, duration: 1.6, ease: 'power2.out', onUpdate: function () { el.textContent = Math.round(o.v); } }); }
      });
    });

    // ── 10) 의료진: 사진이 아래에서 올라오며 열린다 + 두 장이 다른 속도로
    var drPhotos = $$('.dr-photo');
    if (drPhotos.length) {
      gsap.set(drPhotos, { clipPath: 'inset(100% 0% 0% 0% round 999px 999px 18px 18px)' });
      drPhotos.forEach(function (ph, i) {
        gsap.to(ph, { clipPath: 'inset(0% 0% 0% 0% round 999px 999px 18px 18px)', duration: 1.4, delay: i * 0.15, ease: 'power4.inOut', scrollTrigger: { trigger: ph, start: 'top 85%', once: true } });
      });
      var dr2 = $('.dr-card:nth-child(2)');
      if (dr2) gsap.fromTo(dr2, { yPercent: 6 }, { yPercent: -6, ease: 'none', scrollTrigger: { trigger: '.dr', start: 'top bottom', end: 'bottom top', scrub: true } });
    }

    // ── 11) 저서: 책이 돌아서 정면을 본다
    var book = $('.book-cover img');
    if (book) gsap.fromTo(book, { rotateY: -26, x: '-6%' }, { rotateY: 0, x: '0%', ease: 'none', scrollTrigger: { trigger: '.book', start: 'top 85%', end: 'center 45%', scrub: 0.6 } });

    // ── 12) 공간 레일: PC 는 스크롤 따라 흐르고, 모바일은 손으로
    mm.add('(min-width: 901px)', function () {
      var track = $('.fac-track');
      if (!track || !scroller) return;
      touchRail(false);
      gsap.to(track, {
        x: function () { return -(track.scrollWidth - w.innerWidth); }, ease: 'none',
        scrollTrigger: { trigger: '.fac', start: 'top 75%', end: 'bottom 25%', scrub: 0.8, invalidateOnRefresh: true }
      });
      return function () { gsap.set(track, { clearProps: 'transform' }); };
    });
    mm.add('(max-width: 900px)', function () { touchRail(true); });

    // ── 13) 상담 띠·FAQ 제목 등장
    var cMain = $('.contact-main');
    if (cMain) gsap.from(cMain.children, { opacity: 0, y: 34, duration: 1.1, stagger: 0.1, ease: 'power3.out', scrollTrigger: { trigger: cMain, start: 'top 82%', once: true } });

    // 서체·이미지 로드 뒤 트리거 재계산
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(function () { ScrollTrigger.refresh(); });
    w.addEventListener('load', function () { ScrollTrigger.refresh(); });
    setTimeout(done, 4500);
  }
})();
