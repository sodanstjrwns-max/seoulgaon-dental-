/* ============================================
   서울가온치과 · main.js  (v8 ULTRA PREMIUM MOTION)
   40+ Cinematic-Grade Motions — GSAP 3.12
   ============================================ */

(function(){
'use strict';

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

// ──── UTILITIES ────
function splitChars(el){
  const text = el.textContent;
  el.innerHTML = '';
  el.dataset.original = text;
  text.split('').forEach(c => {
    const s = document.createElement('span');
    s.className = 'char';
    s.textContent = c === ' ' ? '\u00A0' : c;
    s.style.display = 'inline-block';
    s.style.willChange = 'transform, opacity';
    el.appendChild(s);
  });
  return el.querySelectorAll('.char');
}

function splitWords(el){
  const text = el.textContent;
  el.innerHTML = '';
  text.split(' ').forEach((w,i) => {
    const s = document.createElement('span');
    s.className = 'word';
    s.textContent = w;
    s.style.display = 'inline-block';
    s.style.willChange = 'transform, opacity';
    if(i > 0){ el.appendChild(document.createTextNode('\u00A0')); }
    el.appendChild(s);
  });
  return el.querySelectorAll('.word');
}

function lerp(a,b,t){ return a + (b - a) * t; }
function clamp(v,min,max){ return Math.min(Math.max(v,min),max); }
function rand(min,max){ return Math.random()*(max-min)+min; }

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   1. CINEMATIC LOADER — Film-Style
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initLoader(){
  const counter = document.querySelector('.loader-counter');
  const chars = document.querySelectorAll('.loader-txt span');
  const line = document.querySelector('.loader-line');
  const sub = document.querySelector('.loader-sub');
  const loader = document.getElementById('loader');
  let count = {val:0};

  document.body.style.overflow='hidden';

  const tl = gsap.timeline({
    onComplete(){
      // Cinematic curtain wipe
      gsap.to(loader,{
        clipPath:'polygon(0 0, 100% 0, 100% 0, 0 0)',
        duration:1.2,
        ease:'power4.inOut',
        onComplete(){
          loader.style.display='none';
          document.body.style.overflow='';
          initAfterLoad();
        }
      });
    }
  });

  tl.to(count,{val:100,duration:2.8,ease:'power3.inOut',
    onUpdate(){
      const v = Math.round(count.val);
      counter.textContent = String(v).padStart(3,'0');
      if(v > 80){
        counter.style.textShadow = `0 0 ${(v-80)*3}px rgba(191,164,106,${(v-80)/40}), 0 0 ${(v-80)*6}px rgba(191,164,106,${(v-80)/80})`;
      }
    }
  })
  .to(chars,{y:0,duration:.9,stagger:{each:.18,ease:'power2.out'},ease:'elastic.out(1.2,.5)'},0.4)
  .to(line,{width:'120px',duration:1,ease:'power3.out'},0.8)
  .fromTo(sub,{opacity:0,filter:'blur(10px)',letterSpacing:'8px'},{opacity:1,filter:'blur(0px)',letterSpacing:'4px',duration:1},1.2);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   2. FILM GRAIN NOISE — Organic Texture
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   3. PREMIUM CURSOR + MAGNETIC TRAIL + MORPHING
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initCursor(){
  if(window.innerWidth<=768) return;
  const cur = document.getElementById('cur');
  const ring = document.getElementById('cur-ring');
  const dot = document.getElementById('cur-dot');
  const label = document.getElementById('cur-label');
  let mx=0,my=0,rx=0,ry=0;
  let vx=0,vy=0,prevMx=0,prevMy=0;
  
  // Trailing ghost particles
  const trailCount = 8;
  const trail = [];
  for(let i=0;i<trailCount;i++){
    const t = document.createElement('div');
    t.className='cur-trail-particle';
    const size = 4 - i * 0.4;
    t.style.cssText=`position:fixed;width:${size}px;height:${size}px;border-radius:50%;pointer-events:none;z-index:9998;mix-blend-mode:screen;background:radial-gradient(circle,rgba(191,164,106,${.3-i*.035}) 0%,transparent 70%);will-change:transform;`;
    document.body.appendChild(t);
    trail.push({el:t,x:0,y:0});
  }

  document.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;});
  
  (function loop(){
    // Velocity for stretch effect
    vx = mx - prevMx;
    vy = my - prevMy;
    prevMx = mx;
    prevMy = my;
    const speed = Math.sqrt(vx*vx+vy*vy);
    
    rx+=(mx-rx)*.1; ry+=(my-ry)*.1;
    
    // Ring stretches based on velocity
    const stretch = clamp(speed*.015, 0, .3);
    const angle = Math.atan2(vy,vx) * 180/Math.PI;
    ring.style.transform=`translate(${rx}px,${ry}px) rotate(${angle}deg) scale(${1+stretch},${1-stretch*.5})`;
    dot.style.transform=`translate(${mx}px,${my}px)`;
    
    // Update trail with physics-based lag
    trail.forEach((t,i)=>{
      const factor = .12 - i*.012;
      const prev = i===0?{x:mx,y:my}:trail[i-1];
      t.x += (prev.x - t.x) * factor;
      t.y += (prev.y - t.y) * factor;
      t.el.style.transform=`translate(${t.x}px,${t.y}px)`;
    });
    
    requestAnimationFrame(loop);
  })();

  // Interactive hover states with label
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
  
  // Image hover → expand cursor
  document.querySelectorAll('.fac-item,.dr-img-wrap,.story-banner').forEach(el=>{
    el.addEventListener('mouseenter',()=>{
      cur.classList.add('hover');
      label.textContent='VIEW';
    });
    el.addEventListener('mouseleave',()=>{
      cur.classList.remove('hover');
      label.textContent='';
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   4. MOUSE-TRACKED RADIAL GLOW
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initMouseGlow(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('[data-glow]').forEach(sec=>{
    const glow = document.createElement('div');
    glow.className = 'mouse-glow-orb';
    glow.style.cssText = 'position:absolute;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,rgba(191,164,106,.07) 0%,transparent 70%);pointer-events:none;will-change:transform;opacity:0;transition:opacity .4s;z-index:0;';
    sec.style.position = 'relative';
    sec.appendChild(glow);
    
    sec.addEventListener('mousemove',e=>{
      const r=sec.getBoundingClientRect();
      const x=e.clientX-r.left-300;
      const y=e.clientY-r.top-300;
      glow.style.transform=`translate(${x}px,${y}px)`;
      glow.style.opacity='1';
    });
    sec.addEventListener('mouseleave',()=>{
      glow.style.opacity='0';
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   5. STICKY NAV + SCROLL DIRECTION HIDE/SHOW
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initNavSticky(){
  const nav = document.getElementById('nav');
  let lastY = 0;
  ScrollTrigger.create({
    trigger:document.body,
    start:'60px top',
    onToggle(self){ nav.classList.toggle('stuck',self.isActive); }
  });
  // Hide on scroll down, show on scroll up
  window.addEventListener('scroll',()=>{
    const y = window.scrollY;
    if(y > 300){
      nav.style.transform = y > lastY ? 'translateY(-100%)' : 'translateY(0)';
    } else {
      nav.style.transform = 'translateY(0)';
    }
    lastY = y;
  });
  nav.style.transition = 'transform .4s cubic-bezier(.4,0,.2,1), background .4s';
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   6. BRAND SCRAMBLE — Enhanced with Glitch
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function scrambleText(el,original,speed=35){
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz가나다라마바사아자차카타파하온설명진료치과';
  let i=0, rounds=0;
  const iv=setInterval(()=>{
    rounds++;
    el.textContent=original.split('').map((c,idx)=>{
      if(idx<i) return c;
      return chars[Math.random()*chars.length|0];
    }).join('');
    if(rounds%3===0) i++;
    if(i>original.length){ clearInterval(iv); el.textContent=original; }
  },speed);
}

function initBrandScramble(){
  const logo = document.querySelector('[data-scramble]');
  if(!logo) return;
  const orig = logo.textContent;
  logo.addEventListener('mouseenter',()=>scrambleText(logo,orig,25));
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   7. HAMBURGER MENU — With Stagger Links
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initHamburger(){
  const btn = document.querySelector('.hamburger');
  const menu = document.querySelector('.mob-menu');
  if(!btn||!menu) return;
  
  btn.addEventListener('click',()=>{
    const opening = !menu.classList.contains('open');
    btn.classList.toggle('open');
    menu.classList.toggle('open');
    document.body.style.overflow = opening?'hidden':'';
    
    if(opening){
      // Stagger link entrance
      gsap.fromTo(menu.querySelectorAll('a'),
        {y:40, opacity:0, rotateX:-15},
        {y:0, opacity:1, rotateX:0, duration:.6, stagger:.08, delay:.3, ease:'back.out(1.5)'}
      );
    }
  });
  menu.querySelectorAll('a').forEach(a=>{
    a.addEventListener('click',()=>{
      btn.classList.remove('open');
      menu.classList.remove('open');
      document.body.style.overflow='';
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   8. SMOOTH SCROLL
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initSmoothScroll(){
  document.querySelectorAll('a[href^="#"]').forEach(a=>{
    a.addEventListener('click',e=>{
      const href=a.getAttribute('href');
      if(href==='#') return;
      const target=document.querySelector(href);
      if(target){
        e.preventDefault();
        gsap.to(window,{scrollTo:{y:target,offsetY:72},duration:1.2,ease:'power3.inOut'});
      }
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   9. SCROLL PROGRESS BAR — with Glow
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initProgressBar(){
  const bar = document.getElementById('progressBar');
  if(!bar) return;
  gsap.to(bar,{
    width:'100%',
    ease:'none',
    scrollTrigger:{trigger:document.body,start:'top top',end:'bottom bottom',scrub:.3}
  });
  // Add glow effect to the tip
  bar.style.boxShadow = '0 0 12px rgba(191,164,106,.6), 0 0 24px rgba(191,164,106,.3)';
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   10. HERO — CHARACTER WAVE REVEAL + 3D DEPTH
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initHeroText(){
  const h1 = document.querySelector('#top h1');
  if(!h1) return;
  
  // Prevent gold text flash before animation
  h1.style.visibility = 'visible';
  const sub = document.querySelector('.hero-sub');
  if(sub) sub.style.visibility = 'visible';

  // Calm line-by-line fade-up reveal
  h1.querySelectorAll('.line span').forEach((lineSpan, lineIdx) => {
    const chars = splitChars(lineSpan);
    gsap.fromTo(chars,
      { 
        y: 40, 
        opacity: 0, 
        filter: 'blur(3px)'
      },
      { 
        y: 0, 
        opacity: 1, 
        filter: 'blur(0px)',
        duration: 1,
        stagger: {
          each: .04,
          ease: 'power2.out'
        },
        ease: 'power3.out',
        delay: .3 + lineIdx * .4,
        transformOrigin: 'bottom center'
      }
    );
  });

  // Sub text — gentle word fade-in
  if(sub){
    const words = splitWords(sub);
    gsap.fromTo(words,
      {opacity:0, y:15, filter:'blur(2px)'},
      {opacity:1, y:0, filter:'blur(0px)', duration:.8, stagger:.12, delay:1.6, ease:'power2.out'}
    );
  }

  // CTA buttons — quiet fade-in
  const heroBtns = document.querySelector('.hero-btns');
  if(heroBtns){
    gsap.fromTo(heroBtns,
      {opacity:0, y:20},
      {opacity:1, y:0, duration:1.2, delay:2.2, ease:'power2.out'}
    );
  }

  // Subtle 3D tilt on mouse (restrained)
  if(window.innerWidth>768){
    const hero = document.getElementById('top');
    hero.addEventListener('mousemove',e=>{
      const r=hero.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5;
      const y=(e.clientY-r.top)/r.height-.5;
      gsap.to(h1,{rotateY:x*6,rotateX:-y*4,duration:.8,ease:'power2.out'});
    });
    hero.addEventListener('mouseleave',()=>{
      gsap.to(h1,{rotateY:0,rotateX:0,duration:1.5,ease:'power3.out'});
    });
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   11. HERO BG CHARS — PARALLAX + FLOAT + GLOW
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initHeroCharsParallax(){
  const chars = document.querySelectorAll('.hero-bg-char');
  chars.forEach((ch,i)=>{
    const dir = i%2===0?-1:1;
    // Gentle parallax on scroll only
    gsap.to(ch,{
      y:dir*80,
      scrollTrigger:{trigger:'#top',start:'top top',end:'bottom top',scrub:2}
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   12. GOLD DUST PARTICLES — Premium Canvas
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initGoldDust(){
  const canvas = document.getElementById('gold-dust');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  let W,H;
  const particles = [];
  const PARTICLE_COUNT = 20;
  let mouseX = 0, mouseY = 0;

  function resize(){
    const hero = document.getElementById('top');
    W = canvas.width = hero.offsetWidth;
    H = canvas.height = hero.offsetHeight;
  }
  resize();
  window.addEventListener('resize',resize);
  
  canvas.parentElement.addEventListener('mousemove',e=>{
    const r = canvas.parentElement.getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
  });

  for(let i=0;i<PARTICLE_COUNT;i++){
    particles.push({
      x:Math.random()*W,
      y:Math.random()*H,
      r:Math.random()*2.5+.3,
      dx:(Math.random()-.5)*.25,
      dy:-Math.random()*.4-.05,
      opacity:Math.random()*.5+.1,
      pulse:Math.random()*Math.PI*2,
      life:Math.random()*200+100
    });
  }

  function draw(){
    ctx.clearRect(0,0,W,H);
    particles.forEach(p=>{
      p.x+=p.dx;
      p.y+=p.dy;
      p.pulse+=.03;
      p.life--;
      
      // Mouse repulsion
      const dx = p.x - mouseX;
      const dy = p.y - mouseY;
      const dist = Math.sqrt(dx*dx+dy*dy);
      if(dist < 150){
        p.x += dx/dist * 1.5;
        p.y += dy/dist * 1.5;
      }
      
      const o = p.opacity*(Math.sin(p.pulse)*.4+.6);
      
      if(p.y<-10 || p.life<=0){ 
        p.y=H+10; p.x=Math.random()*W; 
        p.life=Math.random()*200+100;
        p.opacity=Math.random()*.5+.1;
      }
      if(p.x<-10) p.x=W+10;
      if(p.x>W+10) p.x=-10;

      // Core
      ctx.beginPath();
      ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(212,186,130,${o})`;
      ctx.fill();
      
      // Glow aura
      ctx.beginPath();
      ctx.arc(p.x,p.y,p.r*4,0,Math.PI*2);
      ctx.fillStyle=`rgba(191,164,106,${o*.12})`;
      ctx.fill();
      
      // Occasional sparkle
      if(Math.sin(p.pulse*3) > .95){
        ctx.beginPath();
        ctx.arc(p.x,p.y,p.r*1.5,0,Math.PI*2);
        ctx.fillStyle=`rgba(255,255,255,${o*.4})`;
        ctx.fill();
      }
    });
    requestAnimationFrame(draw);
  }
  draw();
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   13. STAT COUNT-UP — Glitch + Slot Machine
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initCountUp(){
  document.querySelectorAll('[data-count]').forEach(el=>{
    const target = parseInt(el.dataset.count);
    ScrollTrigger.create({
      trigger:el,
      start:'top 85%',
      once:true,
      onEnter(){
        const obj={v:0};
        // Rapid slot-machine phase
        let glitchIv = setInterval(()=>{
          el.textContent = Math.round(Math.random()*target);
          el.style.opacity = Math.random()>.3?'1':'.4';
        },50);
        
        setTimeout(()=>{
          clearInterval(glitchIv);
          el.style.opacity='1';
          gsap.to(obj,{v:target,duration:2,ease:'power2.out',
            onUpdate(){
              const val = Math.round(obj.v);
              // Glitch flicker near end
              if(obj.v > target*.85 && Math.random()>.75){
                el.textContent = val + Math.round((Math.random()-.5)*3);
                el.style.textShadow = `${rand(-3,3)}px 0 rgba(191,164,106,.8), ${rand(-3,3)}px 0 rgba(242,237,228,.4)`;
              } else {
                el.textContent = val;
                el.style.textShadow = 'none';
              }
            },
            onComplete(){
              el.textContent = target;
              el.style.textShadow = 'none';
              // Final golden flash
              gsap.timeline()
                .to(el,{scale:1.2,color:'#fff',textShadow:'0 0 20px rgba(191,164,106,.8)',duration:.15})
                .to(el,{scale:1,color:'var(--gold)',textShadow:'none',duration:.4,ease:'elastic.out(1,.4)'});
            }
          });
        },400);
      }
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   14. SCROLL REVEAL — Multi-Style
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initScrollReveal(){
  // Only target data-reveal that aren't handled by other specific functions
  document.querySelectorAll('[data-reveal]').forEach((el,i)=>{
    // Skip elements that have their own entrance animations
    if(el.classList.contains('value-card') || el.classList.contains('tx-panel') || el.classList.contains('stat')) return;
    
    const style = el.dataset.reveal || 'up';
    let from = {opacity:0, filter:'blur(3px)'};
    
    switch(style){
      case 'left': from.x = -60; break;
      case 'right': from.x = 60; break;
      case 'scale': from.scale = .85; from.y = 20; break;
      default: from.y = 40;
    }
    
    gsap.fromTo(el, from,
      {opacity:1, x:0, y:0, scale:1, filter:'blur(0px)',
        duration:1,
        ease:'power3.out',
        scrollTrigger:{trigger:el,start:'top 92%',once:true},
        delay:(i%4)*.08
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   15. SECTION TITLES — Char-by-Char Wave
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initLineSlideUp(){
  document.querySelectorAll('.sec-title').forEach(title=>{
    title.querySelectorAll('.line span').forEach((span,lineIdx)=>{
      // Reset parent span transform (CSS sets translateY(110%))
      span.style.transform = 'translateY(0)';
      span.style.opacity = '1';
      
      const chars = splitChars(span);
      // Hide chars initially
      gsap.set(chars, {y:'120%', opacity:0});
      
      gsap.to(chars,
        {y:'0%', opacity:1,
          duration:.8,
          stagger:{each:.04, ease:'power2.out'},
          ease:'back.out(1.2)',
          scrollTrigger:{trigger:title,start:'top 88%',once:true},
          delay:lineIdx*.2
        }
      );
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   16. SECTION LABEL SCRAMBLE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initLabelScramble(){
  document.querySelectorAll('[data-scramble-label]').forEach(el=>{
    const orig = el.textContent;
    ScrollTrigger.create({
      trigger:el,
      start:'top 90%',
      once:true,
      onEnter(){ scrambleText(el,orig,20); }
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   17. TX TEXT DANCE — Premium Hover
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initTextDance(){
  document.querySelectorAll('.tx-dance').forEach(h=>{
    const text = h.textContent;
    h.innerHTML = text.split('').map(c=>`<span class="dance-char">${c}</span>`).join('');
    const spans = h.querySelectorAll('.dance-char');
    
    h.addEventListener('mouseenter',()=>{
      spans.forEach((s,i)=>{
        gsap.to(s,{
          y: rand(-14,14),
          x: rand(-6,6),
          rotation: rand(-12,12),
          scale: rand(.85,1.2),
          color: Math.random()>.3?'var(--gold)':'var(--gold-b)',
          textShadow: `0 0 ${rand(6,18)}px rgba(191,164,106,.5)`,
          duration: rand(.25,.4),
          delay: i*.025,
          ease:'power2.out'
        });
      });
    });
    h.addEventListener('mouseleave',()=>{
      gsap.to(spans,{
        y:0,x:0,rotation:0,scale:1,
        color:'var(--ivory)',
        textShadow:'none',
        duration:.6,
        stagger:.02,
        ease:'elastic.out(1,.35)'
      });
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   18. 3D TILT + HOLOGRAPHIC SHINE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initTilt(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('[data-tilt]').forEach(el=>{
    // Add holographic shine overlay
    const shine = document.createElement('div');
    shine.className='tilt-holo-shine';
    shine.style.cssText='position:absolute;inset:0;pointer-events:none;opacity:0;z-index:5;border-radius:inherit;background:linear-gradient(135deg,rgba(191,164,106,.15) 0%,transparent 40%,transparent 60%,rgba(212,186,130,.08) 100%);mix-blend-mode:overlay;';
    el.style.position='relative';
    el.style.overflow='hidden';
    el.appendChild(shine);
    
    el.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5;
      const y=(e.clientY-r.top)/r.height-.5;
      gsap.to(el,{rotateY:x*14,rotateX:-y*10,duration:.35,ease:'power2.out',transformPerspective:800});
      shine.style.opacity='1';
      shine.style.background=`radial-gradient(ellipse at ${(x+.5)*100}% ${(y+.5)*100}%,rgba(191,164,106,.2) 0%,transparent 55%),linear-gradient(${Math.atan2(y,x)*180/Math.PI}deg,rgba(255,255,255,.05) 0%,transparent 50%)`;
    });
    el.addEventListener('mouseleave',()=>{
      gsap.to(el,{rotateY:0,rotateX:0,duration:.9,ease:'elastic.out(1,.3)'});
      shine.style.opacity='0';
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   19. MAGNET BUTTONS + RIPPLE + GLOW
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initMagnet(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('[data-magnet]').forEach(btn=>{
    btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    
    btn.addEventListener('mousemove',e=>{
      const r=btn.getBoundingClientRect();
      const x=e.clientX-r.left-r.width/2;
      const y=e.clientY-r.top-r.height/2;
      gsap.to(btn,{x:x*.4,y:y*.4,duration:.25,ease:'power2.out'});
    });
    btn.addEventListener('mouseleave',()=>{
      gsap.to(btn,{x:0,y:0,duration:.8,ease:'elastic.out(1,.3)'});
    });
    
    // Enhanced ripple on click
    btn.addEventListener('click',e=>{
      const ripple = document.createElement('span');
      ripple.className = 'btn-ripple';
      const r=btn.getBoundingClientRect();
      const size = Math.max(r.width,r.height)*2.5;
      ripple.style.cssText=`position:absolute;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.4) 0%,transparent 70%);transform:scale(0);width:${size}px;height:${size}px;left:${e.clientX-r.left-size/2}px;top:${e.clientY-r.top-size/2}px;pointer-events:none;`;
      btn.appendChild(ripple);
      gsap.to(ripple,{scale:1,opacity:0,duration:.7,ease:'power2.out',onComplete(){ripple.remove()}});
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   20. FAQ ACCORDION — Smooth Height + Rotate
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initFAQ(){
  const qs = document.querySelectorAll('.faq-q');
  qs.forEach(q=>{
    q.addEventListener('click',()=>{
      const wasActive = q.classList.contains('active');
      qs.forEach(oq=>{
        oq.classList.remove('active');
        gsap.to(oq.nextElementSibling,{maxHeight:0,duration:.4,ease:'power2.inOut'});
        gsap.to(oq.querySelector('.plus'),{rotation:0,color:'var(--gold)',duration:.3});
      });
      if(!wasActive){
        q.classList.add('active');
        const a=q.nextElementSibling;
        gsap.to(a,{maxHeight:a.scrollHeight,duration:.5,ease:'power2.out'});
        gsap.to(q.querySelector('.plus'),{rotation:135,color:'var(--ivory)',duration:.3});
      }
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   21. DOCTOR PHOTO SLIDER — Cross-Fade
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initDrSlider(){
  document.querySelectorAll('.dr-card').forEach(card=>{
    const imgs = card.querySelectorAll('.dr-img-wrap img');
    if(imgs.length<=1) return;
    let current = 0;
    setInterval(()=>{
      gsap.to(imgs[current],{opacity:0,scale:1.08,duration:.8,ease:'power2.inOut'});
      current=(current+1)%imgs.length;
      gsap.fromTo(imgs[current],{opacity:0,scale:1.12},{opacity:1,scale:1,duration:.8,ease:'power2.inOut'});
    },3500);
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   22. IMAGE CLIP-PATH REVEAL — Cinematic Wipe
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initImageReveal(){
  document.querySelectorAll('.fac-item, .story-banner').forEach((item,idx)=>{
    const img = item.querySelector('img');
    if(!img) return;
    
    // Alternate wipe directions
    const directions = [
      ['inset(100% 0 0 0)','inset(0% 0 0 0)'],     // bottom
      ['inset(0 100% 0 0)','inset(0 0% 0 0)'],       // right
      ['inset(0 0 100% 0)','inset(0 0 0% 0)'],       // top
      ['inset(0 0 0 100%)','inset(0 0 0 0%)'],        // left
    ];
    const dir = directions[idx % directions.length];
    
    gsap.fromTo(item,
      {clipPath:dir[0]},
      {clipPath:dir[1],
        duration:1.4,
        ease:'power4.out',
        scrollTrigger:{trigger:item,start:'top 90%',once:true}
      }
    );
    gsap.fromTo(img,
      {scale:1.35, filter:'brightness(.7)'},
      {scale:1, filter:'brightness(1)',
        duration:1.6,
        ease:'power2.out',
        scrollTrigger:{trigger:item,start:'top 90%',once:true}
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   23. BACKGROUND TEXT PARALLAX — Enhanced
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initBgParallax(){
  document.querySelectorAll('.contact-bg,.story-bg-text').forEach(el=>{
    gsap.to(el,{
      y:-150,
      x:40,
      scale:1.05,
      scrollTrigger:{trigger:el.parentElement,start:'top bottom',end:'bottom top',scrub:1.5}
    });
  });
  document.querySelectorAll('.tx-panel-bg').forEach(el=>{
    gsap.to(el,{
      y:-80,
      x:-30,
      scrollTrigger:{trigger:el.parentElement,start:'top bottom',end:'bottom top',scrub:1}
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   24. REVIEW CARD TILT — Enhanced
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initRevTilt(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('.rev-card').forEach(card=>{
    card.addEventListener('mousemove',e=>{
      const r=card.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5;
      const y=(e.clientY-r.top)/r.height-.5;
      gsap.to(card,{
        rotateY:x*16,
        rotateX:-y*12,
        boxShadow:`${-x*25}px ${y*25}px 50px rgba(191,164,106,.1)`,
        duration:.25,ease:'power2.out',transformPerspective:600
      });
    });
    card.addEventListener('mouseleave',()=>{
      gsap.to(card,{rotateY:0,rotateX:0,boxShadow:'none',duration:.7,ease:'elastic.out(1,.3)'});
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   25. TX PANELS — Staggered Entrance + Hover
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initTxPanelEntrance(){
  document.querySelectorAll('.tx-panel').forEach((panel,i)=>{
    // Clear CSS-set hidden state
    panel.style.opacity = '0';
    gsap.fromTo(panel,
      {x:i%2===0?-80:80, opacity:0, rotateY:i%2===0?-4:4, scale:.96},
      {x:0, opacity:1, rotateY:0, scale:1,
        duration:1.2,
        ease:'power3.out',
        scrollTrigger:{trigger:panel,start:'top 88%',once:true},
        transformPerspective:1000
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   26. VALUE CARDS — Pop Entrance
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initValueCards(){
  const cards = document.querySelectorAll('.value-card');
  // Clear CSS-set hidden state
  cards.forEach(c => { c.style.opacity = '0'; c.style.transform = 'none'; });
  cards.forEach((card,i)=>{
    gsap.fromTo(card,
      {y:60, opacity:0, scale:.9, rotateX:5},
      {y:0, opacity:1, scale:1, rotateX:0,
        duration:.9,
        delay:i*.15,
        ease:'back.out(1.8)',
        scrollTrigger:{trigger:card.parentElement,start:'top 88%',once:true}
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   27. GOLD DIVIDERS — Line Draw Animation
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initDividers(){
  document.querySelectorAll('.gold-divider').forEach(div=>{
    gsap.fromTo(div,
      {width:0, opacity:0},
      {width:'80px', opacity:1, duration:1.2, ease:'power3.out',
        scrollTrigger:{trigger:div,start:'top 90%',once:true}
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   28. TICKER — Variable Speed on Scroll
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initTickerScroll(){
  const track = document.querySelector('.ticker-track');
  if(!track) return;
  ScrollTrigger.create({
    trigger:'.ticker',
    start:'top bottom',
    end:'bottom top',
    onUpdate(self){
      const speed = 28 - self.progress * 16;
      track.style.animationDuration = speed + 's';
    }
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   29. FOOTER — Stagger Reveal
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initFooterReveal(){
  const footer = document.querySelector('footer');
  if(!footer) return;
  gsap.fromTo(footer.children,
    {y:30, opacity:0},
    {y:0, opacity:1, duration:.7, stagger:.12, ease:'power2.out',
      scrollTrigger:{trigger:footer,start:'top 95%',once:true}
    }
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   30. SCROLL VELOCITY SKEW
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initScrollVelocity(){
  let lastScroll = 0;
  const heroChars = document.querySelectorAll('.hero-bg-char');
  
  window.addEventListener('scroll',()=>{
    const velocity = window.scrollY - lastScroll;
    lastScroll = window.scrollY;
    
    const skew = clamp(velocity*.08, -6, 6);
    heroChars.forEach(ch=>{
      gsap.to(ch,{skewX:skew,duration:.3,ease:'power2.out'});
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   31. SECTION LABEL LINE DRAW
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initSectionWipe(){
  document.querySelectorAll('.sec-label').forEach(label=>{
    const line = document.createElement('span');
    line.className='label-line';
    line.style.cssText='display:block;width:0;height:1px;background:linear-gradient(90deg,var(--gold),transparent);margin-top:8px;';
    label.parentElement.insertBefore(line,label.nextSibling);
    
    gsap.to(line,{
      width:'50px',
      duration:1.2,
      ease:'power3.out',
      scrollTrigger:{trigger:label,start:'top 88%',once:true}
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   32. HORIZONTAL WIPE SECTION REVEALS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initSectionWipeReveal(){
  document.querySelectorAll('.sec-wipe').forEach(sec=>{
    gsap.fromTo(sec,
      {clipPath:'inset(0 100% 0 0)'},
      {clipPath:'inset(0 0% 0 0)',
        duration:1.5,
        ease:'power4.inOut',
        scrollTrigger:{trigger:sec, start:'top 80%', once:true}
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   33. PARALLAX IMAGE LAYERS — on Scroll
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initParallaxImages(){
  document.querySelectorAll('.fac-item img').forEach((img,i)=>{
    gsap.to(img,{
      y: -30 - (i%3)*15,
      scrollTrigger:{
        trigger:img.parentElement,
        start:'top bottom',
        end:'bottom top',
        scrub:1
      }
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   34. VALUE CARD HOVER — Content Lift
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initValueCardHover(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('.value-card').forEach(card=>{
    card.addEventListener('mouseenter',()=>{
      gsap.to(card,{y:-8,borderColor:'rgba(191,164,106,.5)',boxShadow:'0 16px 40px rgba(191,164,106,.1)',duration:.3,ease:'power2.out'});
      gsap.to(card.querySelector('.value-num'),{scale:1.15,color:'var(--gold)',opacity:1,duration:.3});
    });
    card.addEventListener('mouseleave',()=>{
      gsap.to(card,{y:0,borderColor:'var(--line)',boxShadow:'none',duration:.5,ease:'elastic.out(1,.4)'});
      gsap.to(card.querySelector('.value-num'),{scale:1,opacity:.4,duration:.3});
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   35. HERO STATS — Entrance Cascade
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initStatEntrance(){
  const stats = document.querySelectorAll('.stat');
  stats.forEach((stat,i)=>{
    gsap.fromTo(stat,
      {y:60, opacity:0, scale:.8},
      {y:0, opacity:1, scale:1,
        duration:.8,
        delay:1.2 + i*.2,
        ease:'back.out(1.5)'
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   36. SCROLL GUIDE — Pulse + Fade on Scroll
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initScrollGuide(){
  const guide = document.querySelector('.scroll-guide');
  if(!guide) return;
  gsap.fromTo(guide,
    {opacity:0, y:20},
    {opacity:1, y:0, duration:.8, delay:2.2, ease:'power2.out'}
  );
  gsap.to(guide,{
    opacity:0,
    y:-20,
    scrollTrigger:{trigger:'#top',start:'10% top',end:'30% top',scrub:true}
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   37. TX PANEL BORDER GLOW ON HOVER
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initTxPanelHover(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('.tx-panel').forEach(panel=>{
    panel.addEventListener('mouseenter',()=>{
      gsap.to(panel,{
        borderColor:'rgba(191,164,106,.3)',
        boxShadow:'0 0 60px rgba(191,164,106,.06), inset 0 0 30px rgba(191,164,106,.03)',
        duration:.4
      });
    });
    panel.addEventListener('mouseleave',()=>{
      gsap.to(panel,{
        borderColor:'var(--line)',
        boxShadow:'none',
        duration:.6
      });
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   38. FAC GALLERY — Stagger Grid Entrance
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initFacGalleryEntrance(){
  const items = document.querySelectorAll('.fac-item');
  items.forEach((item,i)=>{
    gsap.fromTo(item,
      {opacity:0, scale:.9, y:30},
      {opacity:1, scale:1, y:0,
        duration:.7,
        delay:i*.08,
        ease:'power3.out',
        scrollTrigger:{trigger:item,start:'top 92%',once:true}
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   39. CONTACT SECTION — Dramatic Entrance
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initContactEntrance(){
  const sec = document.getElementById('s-contact');
  if(!sec) return;
  const btns = sec.querySelectorAll('.contact-btn');
  btns.forEach((btn,i)=>{
    gsap.fromTo(btn,
      {y:30, opacity:0, scale:.9},
      {y:0, opacity:1, scale:1,
        duration:.6,
        delay:i*.1,
        ease:'back.out(1.5)',
        scrollTrigger:{trigger:btn,start:'top 90%',once:true}
      }
    );
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   40. STORY SECTION — Text Reveal + Image Zoom
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initStoryReveal(){
  const banner = document.querySelector('.story-banner');
  if(!banner) return;
  
  // Continuous subtle zoom
  gsap.to(banner.querySelector('img'),{
    scale:1.08,
    scrollTrigger:{trigger:banner,start:'top bottom',end:'bottom top',scrub:1.5}
  });
  
  // Quote entrance
  const quote = banner.querySelector('.story-banner-quote');
  if(quote){
    gsap.fromTo(quote,
      {y:40, opacity:0},
      {y:0, opacity:1, duration:1, ease:'power3.out',
        scrollTrigger:{trigger:banner,start:'top 60%',once:true}
      }
    );
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   41. DR CHIP HOVER — Gold Pulse
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initDrChipHover(){
  document.querySelectorAll('.dr-chip').forEach(chip=>{
    chip.addEventListener('mouseenter',()=>{
      gsap.to(chip,{borderColor:'var(--gold)',color:'var(--gold)',scale:1.05,duration:.2});
    });
    chip.addEventListener('mouseleave',()=>{
      if(!chip.classList.contains('gold')){
        gsap.to(chip,{borderColor:'var(--line)',color:'var(--stone-l)',scale:1,duration:.3});
      } else {
        gsap.to(chip,{scale:1,duration:.3});
      }
    });
  });
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   INIT — Orchestrate Everything
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
function initAfterLoad(){
  initNavSticky();
  initBrandScramble();
  initHamburger();
  initSmoothScroll();
  initProgressBar();
  initHeroText();
  initHeroCharsParallax();
  initGoldDust();
  initStatEntrance();
  initCountUp();
  initScrollReveal();
  initLineSlideUp();
  initLabelScramble();
  initTextDance();
  initTilt();
  initMouseGlow();
  initMagnet();
  initFAQ();
  initDrSlider();
  initImageReveal();
  initBgParallax();
  initRevTilt();
  initTxPanelEntrance();
  initTxPanelHover();
  initValueCards();
  initValueCardHover();
  initDividers();
  initTickerScroll();
  initFooterReveal();
  initScrollVelocity();
  initSectionWipe();
  initSectionWipeReveal();
  initParallaxImages();
  initScrollGuide();
  initContactEntrance();
  initFacGalleryEntrance();
  initStoryReveal();
  initDrChipHover();
}

// Start immediately
initNoise();
initCursor();
initLoader();

})();
