/* ============================================
   서울가온치과 · main.js  (v7 REBUILD)
   22 Motions — GSAP 3.12 + ScrollTrigger
   ============================================ */

(function(){
'use strict';

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

/* ---------- 1. LOADER ---------- */
function initLoader(){
  const counter = document.querySelector('.loader-counter');
  const chars   = document.querySelectorAll('.loader-txt span');
  const line    = document.querySelector('.loader-line');
  const sub     = document.querySelector('.loader-sub');
  const loader  = document.getElementById('loader');
  let count = {val:0};

  const tl = gsap.timeline({
    onComplete(){
      gsap.to(loader,{opacity:0,duration:.6,onComplete(){
        loader.style.display='none';
        document.body.style.overflow='';
        initAfterLoad();
      }});
    }
  });
  document.body.style.overflow='hidden';

  tl.to(count,{val:100,duration:2,ease:'power2.inOut',
    onUpdate(){ counter.textContent = Math.round(count.val); }
  })
  .to(chars,{y:0,duration:.7,stagger:.12,ease:'power3.out'},0.3)
  .to(line,{width:'80px',duration:.8,ease:'power2.out'},0.7)
  .to(sub,{opacity:1,duration:.6},1);
}

/* ---------- 2. NOISE CANVAS ---------- */
function initNoise(){
  const c = document.getElementById('noise');
  if(!c) return;
  const ctx = c.getContext('2d');
  let frame = 0;
  function resize(){ c.width=window.innerWidth; c.height=window.innerHeight; }
  resize();
  window.addEventListener('resize',resize);
  function draw(){
    frame++;
    if(frame%3===0){
      const w=c.width,h=c.height;
      const img = ctx.createImageData(w,h);
      const d = img.data;
      for(let i=0;i<d.length;i+=4){
        const v = Math.random()*255|0;
        d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
      }
      ctx.putImageData(img,0,0);
    }
    requestAnimationFrame(draw);
  }
  draw();
}

/* ---------- 3. CUSTOM CURSOR ---------- */
function initCursor(){
  if(window.innerWidth<=768) return;
  const cur = document.getElementById('cur');
  const ring = document.getElementById('cur-ring');
  const dot  = document.getElementById('cur-dot');
  const label = document.getElementById('cur-label');
  let mx=0,my=0,rx=0,ry=0;
  document.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;});
  (function loop(){
    rx+=(mx-rx)*.15; ry+=(my-ry)*.15;
    ring.style.transform=`translate(${rx}px,${ry}px)`;
    dot.style.transform=`translate(${mx}px,${my}px)`;
    requestAnimationFrame(loop);
  })();

  document.querySelectorAll('a,button,[data-magnet]').forEach(el=>{
    el.addEventListener('mouseenter',()=>{
      cur.classList.add('hover');
      const lbl = el.dataset.cursorLabel;
      if(lbl){ label.textContent=lbl; }
    });
    el.addEventListener('mouseleave',()=>{
      cur.classList.remove('hover');
      label.textContent='';
    });
  });
}

/* ---------- 4. NAV STICKY ---------- */
function initNavSticky(){
  const nav = document.getElementById('nav');
  ScrollTrigger.create({
    trigger:document.body,
    start:'60px top',
    onToggle(self){ nav.classList.toggle('stuck',self.isActive); }
  });
}

/* ---------- 5. BRAND SCRAMBLE ---------- */
function scrambleText(el,original){
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz가나다라마바사아자차카타파하';
  let i=0;
  const iv=setInterval(()=>{
    el.textContent=original.split('').map((c,idx)=>idx<i?c:chars[Math.random()*chars.length|0]).join('');
    i++;
    if(i>original.length) clearInterval(iv);
  },40);
}
function initBrandScramble(){
  const logo = document.querySelector('[data-scramble]');
  if(!logo) return;
  const orig = logo.textContent;
  logo.addEventListener('mouseenter',()=>scrambleText(logo,orig));
}

/* ---------- 6. HAMBURGER MENU ---------- */
function initHamburger(){
  const btn = document.querySelector('.hamburger');
  const menu = document.querySelector('.mob-menu');
  if(!btn||!menu) return;
  btn.addEventListener('click',()=>{
    btn.classList.toggle('open');
    menu.classList.toggle('open');
    document.body.style.overflow = menu.classList.contains('open')?'hidden':'';
  });
  menu.querySelectorAll('a').forEach(a=>{
    a.addEventListener('click',()=>{
      btn.classList.remove('open');
      menu.classList.remove('open');
      document.body.style.overflow='';
    });
  });
}

/* ---------- 7. SMOOTH SCROLL ---------- */
function initSmoothScroll(){
  document.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener('click',e=>{
      const href=a.getAttribute('href');
      if(href==='#') return;
      const target=document.querySelector(href);
      if(target){
        e.preventDefault();
        gsap.to(window,{scrollTo:{y:target,offsetY:72},duration:1,ease:'power3.inOut'});
      }
    });
  });
}

/* ---------- 8. SCROLL PROGRESS BAR ---------- */
function initProgressBar(){
  gsap.to('#progressBar',{
    width:'100%',
    ease:'none',
    scrollTrigger:{trigger:document.body,start:'top top',end:'bottom bottom',scrub:.3}
  });
}

/* ---------- 9. HERO CHARS PARALLAX ---------- */
function initHeroCharsParallax(){
  const chars = document.querySelectorAll('.hero-bg-char');
  chars.forEach((ch,i)=>{
    const dir = i%2===0?-1:1;
    gsap.to(ch,{
      y:dir*120,
      scrollTrigger:{trigger:'#top',start:'top top',end:'bottom top',scrub:1}
    });
  });
}

/* ---------- 10. H1 ENTRANCE + TILT ---------- */
function initHeroH1(){
  const h1 = document.querySelector('#top h1');
  if(!h1) return;
  const lines = h1.querySelectorAll('.line span');
  gsap.fromTo(lines,{y:80,opacity:0},{y:0,opacity:1,duration:1,stagger:.15,ease:'power3.out',delay:.3});

  // 3D tilt
  if(window.innerWidth>768){
    h1.addEventListener('mousemove',e=>{
      const r=h1.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5;
      const y=(e.clientY-r.top)/r.height-.5;
      gsap.to(h1,{rotateY:x*12,rotateX:-y*8,duration:.4,ease:'power2.out'});
    });
    h1.addEventListener('mouseleave',()=>{
      gsap.to(h1,{rotateY:0,rotateX:0,duration:.6,ease:'power2.out'});
    });
  }
}

/* ---------- 11. STAT COUNTUP ---------- */
function initCountUp(){
  document.querySelectorAll('[data-count]').forEach(el=>{
    const target = parseInt(el.dataset.count);
    ScrollTrigger.create({
      trigger:el,
      start:'top 85%',
      once:true,
      onEnter(){
        gsap.to({v:0},{v:target,duration:2,ease:'power2.out',
          onUpdate(){ el.textContent=Math.round(this.targets()[0].v); }
        });
      }
    });
  });
}

/* ---------- 12. SCROLL REVEAL ---------- */
function initScrollReveal(){
  document.querySelectorAll('[data-reveal]').forEach(el=>{
    ScrollTrigger.create({
      trigger:el,
      start:'top 88%',
      once:true,
      onEnter(){ el.classList.add('revealed'); }
    });
  });
}

/* ---------- 13. LINE-BY-LINE SLIDE UP ---------- */
function initLineSlideUp(){
  document.querySelectorAll('.sec-title').forEach(title=>{
    const spans = title.querySelectorAll('.line span');
    gsap.fromTo(spans,{y:'110%'},{
      y:'0%',duration:.8,stagger:.12,ease:'power3.out',
      scrollTrigger:{trigger:title,start:'top 85%',once:true}
    });
  });
}

/* ---------- 14. SECTION LABEL SCRAMBLE ---------- */
function initLabelScramble(){
  document.querySelectorAll('[data-scramble-label]').forEach(el=>{
    const orig = el.textContent;
    ScrollTrigger.create({
      trigger:el,
      start:'top 90%',
      once:true,
      onEnter(){ scrambleText(el,orig); }
    });
  });
}

/* ---------- 15. TX TEXT DANCE ---------- */
function initTextDance(){
  document.querySelectorAll('.tx-dance').forEach(h=>{
    const text = h.textContent;
    h.innerHTML = text.split('').map(c=>`<span>${c}</span>`).join('');
    const spans = h.querySelectorAll('span');
    h.addEventListener('mouseenter',()=>{
      spans.forEach(s=>{
        gsap.to(s,{
          y:Math.random()*10-5,
          x:Math.random()*6-3,
          color: Math.random()>.5?'var(--gold)':'var(--ivory)',
          duration:.3,
          ease:'power2.out'
        });
      });
    });
    h.addEventListener('mouseleave',()=>{
      gsap.to(spans,{y:0,x:0,color:'var(--ivory)',duration:.4,ease:'power2.out'});
    });
  });
}

/* ---------- 16. 3D TILT ---------- */
function initTilt(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('[data-tilt]').forEach(el=>{
    el.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5;
      const y=(e.clientY-r.top)/r.height-.5;
      gsap.to(el,{rotateY:x*8,rotateX:-y*6,duration:.4,ease:'power2.out',transformPerspective:800});
    });
    el.addEventListener('mouseleave',()=>{
      gsap.to(el,{rotateY:0,rotateX:0,duration:.6,ease:'power2.out'});
    });
  });
}

/* ---------- 17. MAGNET BUTTONS ---------- */
function initMagnet(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('[data-magnet]').forEach(btn=>{
    btn.addEventListener('mousemove',e=>{
      const r=btn.getBoundingClientRect();
      const x=e.clientX-r.left-r.width/2;
      const y=e.clientY-r.top-r.height/2;
      gsap.to(btn,{x:x*.3,y:y*.3,duration:.3,ease:'power2.out'});
    });
    btn.addEventListener('mouseleave',()=>{
      gsap.to(btn,{x:0,y:0,duration:.5,ease:'elastic.out(1,.4)'});
    });
  });
}

/* ---------- 18. FAQ ACCORDION ---------- */
function initFAQ(){
  const qs = document.querySelectorAll('.faq-q');
  qs.forEach(q=>{
    q.addEventListener('click',()=>{
      const wasActive = q.classList.contains('active');
      qs.forEach(oq=>{
        oq.classList.remove('active');
        oq.nextElementSibling.style.maxHeight='0';
      });
      if(!wasActive){
        q.classList.add('active');
        const a=q.nextElementSibling;
        a.style.maxHeight=a.scrollHeight+'px';
      }
    });
  });
}

/* ---------- 19. DOCTOR PHOTO SLIDER ---------- */
function initDrSlider(){
  // For future multi-image slider, currently single images
  // Placeholder for 3.2s auto-transition
}

/* ---------- 20. IMAGE ZOOM ENTRANCE ---------- */
function initImageZoom(){
  document.querySelectorAll('.fac-item img, .story-banner img').forEach(img=>{
    gsap.fromTo(img,{scale:1.12},{
      scale:1,duration:1.2,ease:'power2.out',
      scrollTrigger:{trigger:img,start:'top 90%',once:true}
    });
  });
}

/* ---------- 21. BG TEXT PARALLAX ---------- */
function initBgParallax(){
  document.querySelectorAll('.contact-bg,.story-bg-text').forEach(el=>{
    gsap.to(el,{
      y:-80,
      scrollTrigger:{trigger:el.parentElement,start:'top bottom',end:'bottom top',scrub:1}
    });
  });
}

/* ---------- 22. REVIEW CARD TILT ---------- */
function initRevTilt(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('.rev-card').forEach(card=>{
    card.addEventListener('mousemove',e=>{
      const r=card.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5;
      const y=(e.clientY-r.top)/r.height-.5;
      gsap.to(card,{rotateY:x*10,rotateX:-y*8,duration:.3,ease:'power2.out',transformPerspective:600});
    });
    card.addEventListener('mouseleave',()=>{
      gsap.to(card,{rotateY:0,rotateX:0,duration:.5,ease:'power2.out'});
    });
  });
}

/* ---------- INIT ON LOAD ---------- */
function initAfterLoad(){
  initNavSticky();
  initBrandScramble();
  initHamburger();
  initSmoothScroll();
  initProgressBar();
  initHeroCharsParallax();
  initHeroH1();
  initCountUp();
  initScrollReveal();
  initLineSlideUp();
  initLabelScramble();
  initTextDance();
  initTilt();
  initMagnet();
  initFAQ();
  initDrSlider();
  initImageZoom();
  initBgParallax();
  initRevTilt();
}

// Start
initNoise();
initCursor();
initLoader();

})();
