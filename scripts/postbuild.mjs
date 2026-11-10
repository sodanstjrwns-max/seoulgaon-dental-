// ============================================================
// postbuild — npm run build 의 vite build 뒤에 실행 (2026-11-05 슈퍼 리뉴얼)
//  1) 정적 자산 ?v= 를 내용 해시로 (dist/*.html + dist/_worker.js 의 HEAD_COMMON) — 고정 버전 문자열 금지(immutable 캐시 사고 방지)
//  2) 정적 HTML 의 h1~h3 에 의미 단위 줄바꿈(phraseBreaks) — SSR 응답은 src/index.tsx 미들웨어가 맡는다
//  3) dist/_routes.json 조정 (옛 package.json 인라인 스크립트 이관)
// 소스(public/, src/)는 건드리지 않는다. ?v=dev 가 소스의 자리표시자.
// ============================================================
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { phraseBreaks } from '../src/lib/phrase.ts'

const DIST = 'dist'
const ASSETS = ['/style.css', '/pages.css', '/pages.js', '/static/home.css', '/static/home.js', '/static/site.js']
const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 10)
const versions = Object.fromEntries(ASSETS.filter((a) => existsSync(join('public', a))).map((a) => [a, hash(join('public', a))]))

function bust(s) {
  for (const [a, v] of Object.entries(versions)) {
    const re = new RegExp(a.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\?v=[A-Za-z0-9_-]*', 'g')
    s = s.replace(re, `${a}?v=${v}`)
  }
  return s
}

let pages = 0, worker = false
for (const f of readdirSync(DIST)) {
  if (!f.endsWith('.html')) continue
  const p = join(DIST, f)
  let s = readFileSync(p, 'utf8')
  s = bust(s)
  if (!/^admin/.test(f)) s = phraseBreaks(s)
  writeFileSync(p, s)
  pages++
}
const wk = join(DIST, '_worker.js')
if (existsSync(wk)) { writeFileSync(wk, bust(readFileSync(wk, 'utf8'))); worker = true }

// _routes.json: SSR 로 넘길 html(블로그·BA·백과·sitemap) 은 exclude 에서 빼고, 정적으로 둘 랜딩 html 은 넣는다
const rp = join(DIST, '_routes.json')
if (existsSync(rp)) {
  const d = JSON.parse(readFileSync(rp, 'utf8'))
  d.exclude = d.exclude.filter((x) => x !== '/sitemap.xml' && x !== '/blog-post.html' && x !== '/blog.html' && x !== '/before-after.html' && x !== '/encyclopedia.html')
  for (const p of ['aesthetic', 'resin-buildup', 'implant']) if (!d.exclude.includes('/' + p + '.html')) d.exclude.push('/' + p + '.html')
  // /llms.txt 는 워커가 맡는다 — 정적 파일에 공개 수가(관리자 수가표 is_published=1)를 끼워 넣음 (2026-11-10)
  d.exclude = d.exclude.filter((x) => x !== '/llms.txt')
  writeFileSync(rp, JSON.stringify(d))
}
console.log(`postbuild: ${pages} html, worker=${worker}, versions=${JSON.stringify(versions)}`)
