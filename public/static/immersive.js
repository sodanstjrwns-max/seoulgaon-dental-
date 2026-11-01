/* 서울가온치과 메인 스크롤 몰입 연출 — 기존 모션(js/main.js: 로더·히어로 글자·금빛 먼지·리빌·와이프·틸트)을 보완하는 얇은 층
   - 기존 모션이 맡는 히어로·철학·진료 패널·이야기·상담·의료진·저서·공간·연락처는 건드리지 않는다
   - 이 층은 관성 스크롤 + 움직임이 없던 의정부 진료 카드·FAQ·진료 안내 띠·둘러보기만 맡는다
   - 톤: 검은 바탕 위 금빛 — 막이 천천히 걷히는 느린 inOut 이징, 짧은 이동
   - 글자는 모두 HTML에 그대로(크롤러·AEO 영향 없음), 동작 줄이기면 아무것도 하지 않음 */
(function () {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  // 첫 화면 로더(약 5초)가 걷히고 main.js 의 initAfterLoad 가 트리거를 만든 뒤에 시작
  var waited = 0;
  function waitLoader() {
    var ld = document.getElementById('loader');
    if (!ld || getComputedStyle(ld).display === 'none' || waited > 12000) { setTimeout(start, 120); return; }
    waited += 150;
    setTimeout(waitLoader, 150);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitLoader); else waitLoader();

  function start() {
  var root = document.documentElement;
  root.classList.add('mx');
  var mobile = matchMedia('(max-width: 767px)').matches;
  var fine = matchMedia('(pointer: fine)').matches;
  var CURTAIN = 'power3.inOut';

  // 1) 관성 스크롤 — 마우스·트랙패드 + 표준 모드만 (터치는 기본 스크롤)
  var lenis = null;
  if (fine && window.Lenis && document.compatMode === 'CSS1Compat') {
    lenis = new Lenis({ duration: 1.25, smoothWheel: true, wheelMultiplier: 0.9 });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
    gsap.ticker.lagSmoothing(0);
    // main.js 의 ScrollTo 부드러운 이동 대신 Lenis 로 (둘이 동시에 창을 끌지 않게)
    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var id = a.getAttribute('href');
        if (id.length < 2) return;
        var target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        lenis.scrollTo(target, { offset: -72, duration: 1.4 });
      }, true);
    });
  }

  // ── 엔진: 화면에 들어오면 한 번 재생, 빠르게 지나쳐도 끝 상태 보장
  var TIMING = ['duration', 'ease', 'stagger', 'delay'];
  var claimed = [];
  function claim(list) { gsap.utils.toArray(list).forEach(function (el) { claimed.push(el); }); }
  function isClaimed(el) { return claimed.some(function (c) { return c === el || c.contains(el) || el.contains(c); }); }
  function enter(targets, vars, trigger, startAt) {
    targets = gsap.utils.toArray(targets);
    if (!targets.length) return null;
    claim(targets);
    var from = {}, to = { opacity: 1, x: 0, y: 0, xPercent: 0, yPercent: 0, rotate: 0, rotateX: 0, rotateY: 0, scale: 1, paused: true,
      onStart: function () { gsap.set(targets, { transition: 'none' }); },
      onComplete: function () { gsap.set(targets, { clearProps: 'opacity,transform,transition,clipPath' }); } };
    Object.keys(vars).forEach(function (k) { (TIMING.indexOf(k) > -1 ? to : from)[k] = vars[k]; });
    if ('clipPath' in from) to.clipPath = 'inset(0% 0% 0% 0%)';
    var tw = gsap.fromTo(targets, from, to);
    var item = { tw: tw, el: trigger || targets[0] };
    pending.push(item);
    ScrollTrigger.create({ trigger: item.el, start: startAt || 'top 88%', once: true, onEnter: function () { play(item); } });
    return tw;
  }
  // 재생 + 탭이 숨겨져 프레임이 멈춰도 끝 상태 보장
  var pending = [];
  function play(item) {
    var i = pending.indexOf(item);
    if (i > -1) pending.splice(i, 1);
    if (item.tw.progress() > 0) return;
    item.tw.play();
    setTimeout(function () { if (item.tw.progress() < 1) item.tw.progress(1); }, (item.tw.totalDuration() + 0.6) * 1000);
  }
  // 한 번에 건너뛴 구간(앵커 이동·빠른 점프)은 콜백이 생략될 수 있으므로 화면 위·안에 있는 대기 연출을 모두 재생
  function sweep() {
    pending.slice().forEach(function (it) { if (it.el.getBoundingClientRect().top < innerHeight * 0.92) play(it); });
  }
  ScrollTrigger.addEventListener('scrollEnd', sweep);
  // 그라데이션 글씨(background-clip:text) 안을 낱말로 쪼개면 글자가 투명해진다
  // → 그 요소 자체를 낱말 하나처럼 통째로 감싸 움직인다(요소 자신의 clip:text 는 transform 이 있어도 정상).
  function clipTextHost(node) {
    for (var e = node.parentElement; e; e = e.parentElement) {
      var cs = getComputedStyle(e);
      if (cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text') return e;
    }
    return null;
  }
  function splitWords(el) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var hosts = [];
    while (walker.nextNode()) {
      var host = clipTextHost(walker.currentNode);
      if (host) { if (hosts.indexOf(host) < 0) hosts.push(host); continue; }
      nodes.push(walker.currentNode);
    }
    hosts.forEach(function (h) {
      if (h === el || h.contains(el)) return; // 제목 전체가 그라데이션(또는 그 안)이면 쪼개지 않음
      var w = document.createElement('span'); w.className = 'mx-w';
      h.parentNode.insertBefore(w, h); w.appendChild(h); h.classList.add('mx-wi');
    });
    nodes.forEach(function (node) {
      var parts = node.textContent.split(/(\s+)/);
      if (parts.join('').trim() === '') return;
      var frag = document.createDocumentFragment();
      parts.forEach(function (p) {
        if (!p) return;
        if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); return; }
        var w = document.createElement('span'); w.className = 'mx-w';
        var i = document.createElement('span'); i.className = 'mx-wi'; i.textContent = p;
        w.appendChild(i); frag.appendChild(w);
      });
      node.parentNode.replaceChild(frag, node);
    });
    return el.querySelectorAll('.mx-wi');
  }
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return gsap.utils.toArray((ctx || document).querySelectorAll(sel)); };
  function scrub(target, from, to, st) {
    claim(target);
    return gsap.fromTo(target, from, Object.assign({ ease: 'none', scrollTrigger: Object.assign({ scrub: true }, st) }, to));
  }
  // 사진 시차: CSS translate 속성만 움직여 기존 hover 확대(transform)와 겹치지 않게
  function drift(img, box, amt) {
    if (!img || !box) return;
    box.classList.add('mx-par');
    gsap.fromTo(img, { translate: '0 ' + (-amt) + '%' }, { translate: '0 ' + amt + '%', ease: 'none',
      scrollTrigger: { trigger: box, start: 'top bottom', end: 'bottom top', scrub: true } });
  }

  // ── 의정부 진료 안내: 제목 낱말, 사진 카드는 막이 아래에서 위로 걷히듯 차례로 드러남
  var ub = $('#s-uijeongbu');
  if (ub) {
    var h = $('#ub-home-h', ub);
    if (h) enter(splitWords(h), { yPercent: 110, duration: 1.2, ease: 'power4.out', stagger: 0.06 }, h, 'top 88%');
    var lead = h && h.nextElementSibling;
    if (lead) enter(lead, { y: 16, opacity: 0, duration: 1.1, ease: 'power3.out' }, lead, 'top 90%');
    var cards = $$('.ub-cards > li', ub);
    if (cards.length) enter(cards, { clipPath: 'inset(100% 0% 0% 0%)', y: 30, duration: 1.3, ease: CURTAIN,
      stagger: { each: 0.1, grid: 'auto', from: 'start' } }, cards[0], 'top 86%');
    $$('.ub-card-img', ub).forEach(function (b) { drift($('img', b), b, 5); });
  }

  // ── 자주 묻는 질문: 질문 줄이 한 줄씩 차분히 올라옴 (열고 닫기는 기존 그대로)
  var faqs = $$('#s-faq .faq-item');
  if (faqs.length) enter(faqs, { y: 22, opacity: 0, duration: 0.9, ease: 'power3.out', stagger: 0.05 }, faqs[0], 'top 90%');

  // ── 진료 안내 띠(흐르는 카드): 스크롤을 빠르게 할수록 띠가 빨라졌다가 천천히 원래 속도로
  var track = $('#s-rev .rev-track');
  if (track && track.getAnimations) {
    var anim = track.getAnimations()[0];
    if (anim) {
      var speed = { r: 1 };
      var apply = function () { anim.playbackRate = speed.r; };
      ScrollTrigger.create({ trigger: '#s-rev', start: 'top bottom', end: 'bottom top', onUpdate: function (self) {
        var v = Math.min(4, 1 + Math.abs(self.getVelocity()) / 600);
        if (v > speed.r + 0.05) { gsap.killTweensOf(speed); speed.r = v; apply(); }
        gsap.to(speed, { r: 1, duration: 1.2, ease: 'power2.out', overwrite: true, onUpdate: apply });
      } });
    }
  }

  // ── 둘러보기: 제목 낱말, 칸마다 금빛 제목이 먼저 걸리고 링크가 목차처럼 한 줄씩
  var ex = $('#s-explore');
  if (ex) {
    var et = $('.explore-title', ex);
    if (et) enter(splitWords(et), { yPercent: 110, duration: 1.1, ease: 'power4.out', stagger: 0.05 }, et, 'top 90%');
    $$('.explore-col', ex).forEach(function (col, ci) {
      var h3 = $('h3', col);
      if (h3) enter(h3, { x: -16, opacity: 0, duration: 0.8, ease: 'power3.out', delay: ci * 0.06 }, col, 'top 92%');
      var links = $$('li', col);
      if (links.length) enter(links, { x: -14, opacity: 0, duration: 0.7, ease: 'power3.out', stagger: 0.03, delay: 0.12 + ci * 0.06 }, col, 'top 92%');
    });
  }

  // 주소에 #앵커가 있으면 — 트리거 계산이 브라우저의 앵커 이동을 끊으므로 다시 그 자리로
  var touched = false;
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) { window.addEventListener(ev, function () { touched = true; }, { once: true, passive: true }); });
  function toHash() {
    var id = location.hash;
    if (touched) return;
    if (id.length < 2) return;
    var t; try { t = document.querySelector(decodeURIComponent(id)); } catch (e) { return; }
    if (!t) return;
    var y = t.getBoundingClientRect().top + window.pageYOffset - 72;
    if (lenis) lenis.scrollTo(y, { immediate: true }); else window.scrollTo(0, y);
  }
  ScrollTrigger.refresh();
  toHash();
  sweep();
  // 이미지가 늦게 로드되면 위치 다시 계산
  window.addEventListener('load', function () { ScrollTrigger.refresh(); toHash(); sweep(); });
  }
})();
