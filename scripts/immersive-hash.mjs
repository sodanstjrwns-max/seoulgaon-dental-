// 홈 스크롤 몰입 연출 정적 파일(public/static/immersive.{css,js})의 내용 해시를
// public/index.html 의 ?v= 에 반영한다 (고정 버전 문자열 금지 — immutable 캐시 사고 방지). npm run build 가 먼저 실행.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 10)
const page = 'public/index.html'
let html = readFileSync(page, 'utf8')
for (const ext of ['css', 'js']) {
  const re = new RegExp(`/static/immersive\\.${ext}\\?v=[0-9a-f]*`, 'g')
  html = html.replace(re, `/static/immersive.${ext}?v=${hash(`public/static/immersive.${ext}`)}`)
}
writeFileSync(page, html)
