// ============================================================
// 의미 단위 줄바꿈 (2026-11-05) — thebarunface·seoul365 `phraseBreaks` 이식
//  - h1·h2·h3 와 .display/.lead-big/.quote-big/.tagline 문구를 문장(. ? !)·쉼표 절 단위 inline-block 덩어리로 묶는다.
//  - 덩어리 안에서는 줄이 바뀌지 않고 덩어리 사이에서만 바뀐다 → "…의정부 / 임플란트의…" 같은 중간 끊김 방지.
//  - 태그 안(em·a·span 등) 텍스트는 건드리지 않는다. 짧은 절(6자 미만)은 다음 절과 합친다.
//  - 손으로 .ph 를 넣은 제목(홈)은 건너뛴다. SSR 응답은 src/index.tsx 미들웨어, 정적 HTML 은 scripts/postbuild.mjs 가 dist 에 적용.
// ============================================================

const PHRASE_TAGS = /<(h1|h2|h3)(\s[^>]*)?>([\s\S]*?)<\/\1>|<(p|blockquote|span)(\s[^>]*class="[^"]*\b(?:display|lead-big|quote-big|tagline)\b[^"]*"[^>]*)>([\s\S]*?)<\/\4>/g
const plain = (h: string) => h.replace(/<[^>]+>/g, '').trim()

/** 태그 바깥(깊이 0) 텍스트에서만 구분자로 나눈다 */
function splitTop(inner: string, re: RegExp): string[] {
  const parts: string[] = []
  let buf = ''
  let depth = 0
  for (const tk of inner.split(/(<[^>]+>)/)) {
    if (tk.startsWith('<')) {
      if (/^<\//.test(tk)) depth--
      else if (!/\/>$/.test(tk) && !/^<(br|img|wbr|input|hr)\b/i.test(tk)) depth++
      buf += tk
      continue
    }
    if (depth > 0) { buf += tk; continue }
    const segs = tk.split(re)
    segs.forEach((sg, i) => { buf += sg; if (i < segs.length - 1) { parts.push(buf); buf = '' } })
  }
  parts.push(buf)
  return parts.map(x => x.trim()).filter(Boolean)
}

/** 짧은 조각(6자 미만)은 다음 조각과 합친다 */
function mergeShort(parts: string[]): string[] {
  const out: string[] = []
  for (const pt of parts) {
    if (out.length && plain(out[out.length - 1]).length < 6) out[out.length - 1] += ' ' + pt
    else out.push(pt)
  }
  return out
}

function chunk(inner: string): string {
  if (inner.includes('class="ph-c"') || inner.includes('class="ph"') || inner.includes('<h') || !/[.,?!]\s/.test(plain(inner))) return inner
  const sentences = splitTop(inner, /(?<=[.?!]["”’)]?)\s+/)
  const html = sentences.map(sn => {
    const clauses = mergeShort(splitTop(sn, /(?<=,)\s+/))
    return clauses.length > 1
      ? `<span class="ph-c">${clauses.map(c => `<span class="ph-c">${c}</span>`).join(' ')}</span>`
      : `<span class="ph-c">${sn}</span>`
  })
  return html.length > 1 || (sentences.length === 1 && html[0].includes('</span> <span')) ? html.join(' ') : inner
}

export function phraseBreaks(html: string): string {
  return html.replace(PHRASE_TAGS, (m, t1, a1, in1, t2, a2, in2) =>
    t1 ? `<${t1}${a1 || ''}>${chunk(in1)}</${t1}>` : `<${t2}${a2}>${chunk(in2)}</${t2}>`)
}
