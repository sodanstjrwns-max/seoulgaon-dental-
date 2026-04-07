/* ============================================
   서울가온치과 · pages.js  (서브페이지 전용)
   13 Motions — Vanilla JS + CSS Transitions
   ============================================ */
(function(){
'use strict';

/* ---------- 1. CURSOR ---------- */
function initCursor(){
  if(window.innerWidth<=768) return;
  const cur = document.getElementById('cur');
  const ring = document.getElementById('cur-ring');
  const dot  = document.getElementById('cur-dot');
  if(!cur) return;
  let mx=0,my=0,rx=0,ry=0;
  document.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;});
  (function loop(){
    rx+=(mx-rx)*.15; ry+=(my-ry)*.15;
    ring.style.transform=`translate(${rx}px,${ry}px)`;
    dot.style.transform=`translate(${mx}px,${my}px)`;
    requestAnimationFrame(loop);
  })();
  document.querySelectorAll('a,button,[data-magnet]').forEach(el=>{
    el.addEventListener('mouseenter',()=>cur.classList.add('hover'));
    el.addEventListener('mouseleave',()=>cur.classList.remove('hover'));
  });
}

/* ---------- 2. NAV (always stuck) ---------- */
// Nav is always stuck on sub-pages (CSS sets fixed bg)

/* ---------- 3. MOBILE MENU ---------- */
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

/* ---------- 4. SCROLL PROGRESS BAR ---------- */
function initProgressBar(){
  const bar = document.createElement('div');
  bar.id='progressBar';
  document.body.prepend(bar);
  window.addEventListener('scroll',()=>{
    const h = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = h>0?(window.scrollY/h*100)+'%':'0%';
  });
}

/* ---------- 5. HERO ENTRANCE ---------- */
function initHeroEntrance(){
  const hero = document.querySelector('.page-hero');
  if(!hero) return;
  const label = hero.querySelector('.page-hero-label');
  const h1 = hero.querySelector('h1');
  const sub = hero.querySelector('.page-hero-sub');
  const tabs = hero.querySelector('.page-tabs');
  const bg = hero.querySelector('.page-hero-bg');

  const els = [label,h1,sub,tabs].filter(Boolean);
  els.forEach((el,i)=>{
    setTimeout(()=>{
      el.style.transition='opacity .7s ease, transform .7s ease';
      el.style.opacity='1';
      el.style.transform='translateY(0)';
    },200+i*150);
  });
  if(bg){
    bg.style.transition='opacity 1s ease';
    bg.style.opacity='.04';
  }
}

/* ---------- 6. SCROLL REVEAL ---------- */
function initScrollReveal(){
  const els = document.querySelectorAll('[data-reveal]');
  const observer = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if(e.isIntersecting){
        e.target.classList.add('revealed');
        observer.unobserve(e.target);
      }
    });
  },{threshold:.1,rootMargin:'0px 0px -10% 0px'});
  els.forEach(el=>observer.observe(el));
}

/* ---------- 7. FILTER ---------- */
function initFilter(){
  const btns = document.querySelectorAll('.filter-btn');
  const cards = document.querySelectorAll('[data-category]');
  if(!btns.length) return;

  btns.forEach(btn=>{
    btn.addEventListener('click',()=>{
      btns.forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const cat = btn.dataset.filter;
      cards.forEach(card=>{
        if(cat==='all'||card.dataset.category===cat){
          card.style.display='';
          card.style.opacity='0';
          card.style.transform='translateY(20px)';
          requestAnimationFrame(()=>{
            card.style.transition='opacity .5s ease, transform .5s ease';
            card.style.opacity='1';
            card.style.transform='translateY(0)';
          });
        } else {
          card.style.opacity='0';
          card.style.transform='translateY(20px)';
          setTimeout(()=>{card.style.display='none';},300);
        }
      });
    });
  });
}

/* ---------- 8. NOTICE ACCORDION ---------- */
function initAccordion(){
  const qs = document.querySelectorAll('.notice-q');
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
  // Auto-open items marked with data-open
  document.querySelectorAll('.notice-q[data-open]').forEach(q=>{
    q.classList.add('active');
    const a=q.nextElementSibling;
    a.style.maxHeight=a.scrollHeight+'px';
  });
}

/* ---------- 9. TX TAB HIGHLIGHT ---------- */
function initTxTabs(){
  const tabs = document.querySelectorAll('.page-tab[data-target]');
  if(!tabs.length) return;
  const sections = [];
  tabs.forEach(t=>{
    const sec = document.querySelector(t.dataset.target);
    if(sec) sections.push({tab:t,sec});
  });
  window.addEventListener('scroll',()=>{
    const y = window.scrollY + 200;
    let active = sections[0];
    sections.forEach(s=>{
      if(s.sec.offsetTop <= y) active=s;
    });
    tabs.forEach(t=>t.classList.remove('active'));
    if(active) active.tab.classList.add('active');
  });
}

/* ---------- 10. CARD ENTRANCE ---------- */
function initCardEntrance(){
  const cards = document.querySelectorAll('.blog-card,.ba-card,.tx-card-item');
  const observer = new IntersectionObserver((entries)=>{
    entries.forEach((e,i)=>{
      if(e.isIntersecting){
        setTimeout(()=>{
          e.target.style.transition='opacity .6s ease, transform .6s ease';
          e.target.style.opacity='1';
          e.target.style.transform='translateY(0)';
        },i*80);
        observer.unobserve(e.target);
      }
    });
  },{threshold:.05});
  cards.forEach(c=>{
    c.style.opacity='0';
    c.style.transform='translateY(30px)';
    observer.observe(c);
  });
}

/* ---------- 11. MAGNET BUTTONS ---------- */
function initMagnet(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('[data-magnet]').forEach(btn=>{
    btn.addEventListener('mousemove',e=>{
      const r=btn.getBoundingClientRect();
      const x=e.clientX-r.left-r.width/2;
      const y=e.clientY-r.top-r.height/2;
      btn.style.transition='transform .2s ease';
      btn.style.transform=`translate(${x*.3}px,${y*.3}px)`;
    });
    btn.addEventListener('mouseleave',()=>{
      btn.style.transition='transform .5s cubic-bezier(.68,-.55,.265,1.55)';
      btn.style.transform='translate(0,0)';
    });
  });
}

/* ---------- 12. 3D TILT ---------- */
function initTilt(){
  if(window.innerWidth<=768) return;
  document.querySelectorAll('[data-tilt]').forEach(el=>{
    el.addEventListener('mousemove',e=>{
      const r=el.getBoundingClientRect();
      const x=(e.clientX-r.left)/r.width-.5;
      const y=(e.clientY-r.top)/r.height-.5;
      el.style.transition='transform .3s ease';
      el.style.transform=`perspective(800px) rotateY(${x*8}deg) rotateX(${-y*6}deg)`;
    });
    el.addEventListener('mouseleave',()=>{
      el.style.transition='transform .5s ease';
      el.style.transform='perspective(800px) rotateY(0) rotateX(0)';
    });
  });
}

/* ---------- 13. FOOTER ENTRANCE ---------- */
function initFooterEntrance(){
  const footer = document.querySelector('footer');
  if(!footer) return;
  const children = footer.children;
  const observer = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if(e.isIntersecting){
        Array.from(children).forEach((ch,i)=>{
          ch.style.opacity='0';
          ch.style.transform='translateY(15px)';
          setTimeout(()=>{
            ch.style.transition='opacity .6s ease, transform .6s ease';
            ch.style.opacity='1';
            ch.style.transform='translateY(0)';
          },i*120);
        });
        observer.unobserve(e.target);
      }
    });
  },{threshold:.2});
  observer.observe(footer);
}

/* ---------- 14. MEMBER NAV BUTTON ---------- */
function initMemberNav(){
  const nav = document.getElementById('nav');
  if(!nav) return;

  /* — 데스크톱: nav-cta(예약상담) 앞에 회원 버튼 삽입 — */
  const cta = nav.querySelector('.nav-cta');
  if(cta){
    const wrap = document.createElement('div');
    wrap.className = 'nav-member';
    cta.parentNode.insertBefore(wrap, cta);
    renderNavMember(wrap, false);
  }

  /* — 모바일 메뉴: mob-menu 맨 아래에 추가 — */
  const mob = document.querySelector('.mob-menu');
  if(mob){
    const divider = document.createElement('div');
    divider.className = 'mob-member-divider';
    mob.appendChild(divider);
    const wrap2 = document.createElement('div');
    wrap2.className = 'mob-member';
    mob.appendChild(wrap2);
    renderNavMember(wrap2, true);
  }
}

function renderNavMember(container, isMobile){
  const token = localStorage.getItem('gaon_member_token');
  const userStr = localStorage.getItem('gaon_member_user');
  let user = null;
  try{ user = JSON.parse(userStr); }catch(e){}

  if(token && user){
    /* 로그인 상태 */
    if(isMobile){
      container.innerHTML =
        '<span class="mob-member-name"><i class="fas fa-user-circle"></i> '+escHtml(user.name)+'님</span>'+
        '<a href="#" class="mob-member-logout" onclick="window.__memberLogout();return false">로그아웃</a>';
    } else {
      container.innerHTML =
        '<span class="nav-member-name"><i class="fas fa-user-circle"></i> '+escHtml(user.name)+'</span>'+
        '<a href="#" class="nav-member-logout" onclick="window.__memberLogout();return false">로그아웃</a>';
    }
  } else {
    /* 비로그인 상태 */
    if(isMobile){
      container.innerHTML =
        '<a href="/signup.html" class="mob-member-signup"><i class="fas fa-user-plus"></i> 회원가입 / 로그인</a>';
    } else {
      container.innerHTML =
        '<a href="/signup.html" class="nav-member-btn" data-magnet><i class="fas fa-user-plus"></i> 회원가입</a>';
    }
  }
}

function escHtml(s){
  const d=document.createElement('div'); d.textContent=s; return d.innerHTML;
}

/* 전역 로그아웃 함수 */
window.__memberLogout = function(){
  localStorage.removeItem('gaon_member_token');
  localStorage.removeItem('gaon_member_user');
  location.reload();
};

/* ---------- INIT ---------- */
document.addEventListener('DOMContentLoaded',()=>{
  initMemberNav();
  initCursor();
  initHamburger();
  initProgressBar();
  initHeroEntrance();
  initScrollReveal();
  initFilter();
  initAccordion();
  initTxTabs();
  initCardEntrance();
  initMagnet();
  initTilt();
  initFooterEntrance();
});

})();
