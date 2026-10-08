import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-pages'
import { ENC_ENRICH, ENC_ENRICH_DATE, ENC_ALIASES, ENC_TREAT_LABELS } from './data/enc-enrich'

// ══════════════════════════════════════════════════
//  TYPE DEFINITIONS
// ══════════════════════════════════════════════════
type Bindings = {
  DB: D1Database
  R2: R2Bucket
}

type Variables = {
  user: { id: number; email: string; name: string; role: string }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ══════════════════════════════════════════════════
//  slug 안전 정규화 — 깨진 slug 저장 원천 차단 (2026-07-21)
//  대문자/공백/슬래시/특수문자/한글이 slug에 들어가면 URL이 깨져 색인 불가.
//  이 함수를 거치면 반드시 소문자-영문-숫자-하이픈 형태만 남는다.
// ══════════════════════════════════════════════════
function normalizeSlug(raw: string): string {
  if (!raw) return ''
  let s = raw.trim().toLowerCase()
  // 슬래시·공백·언더스코어·점 등 구분자를 하이픈으로
  s = s.replace(/[\s/\\_.,;:!?()[\]{}'"“”‘’]+/g, '-')
  // 영문 소문자/숫자/하이픈만 남기고 나머지(한글·특수문자·악센트) 제거
  s = s.replace(/[^a-z0-9-]/g, '')
  // 연속 하이픈 압축 + 양끝 하이픈 제거
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  return s
}

// slug가 안전한 형식인지 검증 (소문자-영문-숫자-하이픈, 한글/대문자/공백 불가)
function isValidSlug(s: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)
}

// ══════════════════════════════════════════════════
//  IndexNow — 새 콘텐츠 자동 색인 요청 (Bing, Yandex, Naver)
// ══════════════════════════════════════════════════
const INDEXNOW_KEY = 'a1b2c3d4e5f6g7h8i9j0seoulgaon'
async function submitIndexNow(urls: string[]) {
  if (!urls.length) return
  const payload = {
    host: 'seoulgaondc.kr',
    key: INDEXNOW_KEY,
    keyLocation: `https://seoulgaondc.kr/${INDEXNOW_KEY}.txt`,
    urlList: urls,
  }
  // Submit to multiple engines in parallel (fire-and-forget)
  const engines = [
    'https://api.indexnow.org/indexnow',
    'https://www.bing.com/indexnow',
    'https://yandex.com/indexnow',
  ]
  await Promise.allSettled(engines.map(engine =>
    fetch(engine, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    }).catch(() => {})
  ))
}

// ══════════════════════════════════════════════════
//  MIDDLEWARE
// ══════════════════════════════════════════════════

// URL 정규화 301 리다이렉트 — 중복 콘텐츠 방지 (끝슬래시 제거, 경로 소문자화)
// 구글봇이 /encyclopedia/implant/ 또는 /ENCYCLOPEDIA/implant 같은 변형으로
// 들어오면 SPA fallback(홈)으로 떨어져 canonical이 깨지는 문제를 차단
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  let path = url.pathname

  // API·정적파일·루트는 정규화 제외
  const isAsset = path.startsWith('/api/') || path.startsWith('/static/') ||
    /\.[a-zA-Z0-9]{2,5}$/.test(path)
  if (path !== '/' && !isAsset) {
    let normalized = path

    // 1) 끝 슬래시 제거 (/encyclopedia/implant/ -> /encyclopedia/implant)
    if (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.replace(/\/+$/, '')
    }

    // 2) 경로의 라우트 prefix만 소문자화 (slug 부분은 이미 소문자라 안전)
    //    /ENCYCLOPEDIA/implant -> /encyclopedia/implant
    const segMatch = normalized.match(/^\/([^\/]+)(\/.*)?$/)
    if (segMatch) {
      const prefix = segMatch[1]
      const knownPrefixes = ['encyclopedia', 'blog', 'before-after', 'treatments',
        'doctors', 'philosophy', 'guide', 'faq', 'notice', 'community', 'reservation']
      if (knownPrefixes.includes(prefix.toLowerCase()) && prefix !== prefix.toLowerCase()) {
        normalized = '/' + prefix.toLowerCase() + (segMatch[2] || '')
      }
    }

    if (normalized !== path) {
      return c.redirect(normalized + url.search, 301)
    }
  }

  await next()
})

// SEO & Security Headers — 모든 응답에 적용
app.use('*', async (c, next) => {
  await next()
  const url = new URL(c.req.url)
  const path = url.pathname

  // 보안 헤더
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'SAMEORIGIN')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (new URL(c.req.url).protocol === 'https:') c.header('Strict-Transport-Security', 'max-age=31536000')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)')

  // HTML 페이지 캐시: 짧게 (SEO 크롤러가 최신 콘텐츠 수집)
  if (path === '/' || path.match(/^\/(treatments|doctors|philosophy|guide|faq|blog|notice|encyclopedia|before-after|signup|community|reservation|aesthetic|resin-buildup|implant|uijeongbu-dental|endodontics|invisalign|orthodontics|cavity-treatment|implant-best|full-mouth-implant|front-tooth-implant|bone-graft-implant|laminate|wisdom-tooth|scaling-gum-treatment|denture-to-implant|implant-cost|night-dental|senior-implant|emergency-dental|tapseok-dental|painless-dental|pediatric-dental|crown|teeth-whitening|dental-checkup|implant-process|minrak-dental)$/) || path.match(/^\/(blog|before-after)\/\d+$/) || path.match(/^\/encyclopedia\/[^\/]+$/)) {
    c.header('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200')
    // 라우트 핸들러가 noindex를 지정한 페이지(비포애프터 상세, 얇은 블로그 글)는 덮어쓰지 않음
    if (!(c.res.headers.get('X-Robots-Tag') || '').includes('noindex')) {
      c.header('X-Robots-Tag', 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1')
    }
  }
  // admin은 검색엔진 차단
  if (path === '/admin') {
    c.header('X-Robots-Tag', 'noindex, nofollow')
    c.header('Cache-Control', 'no-store, private')
  }
  // 정적 자산: 장기 캐시
  if (path.match(/\.(js|css|png|jpg|jpeg|webp|svg|ico|woff2?)$/)) {
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
  }
  if (c.res.status >= 400) {
    c.header('X-Robots-Tag', 'noindex, follow')
    c.header('Cache-Control', 'no-store')
  }
})

app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

// Global error handler
app.onError((err, c) => {
  console.error('[API ERROR]', err.message, err.stack)
  return c.json({ error: '서버 오류가 발생했습니다', detail: err.message }, 500)
})

// ══════════════════════════════════════════════════
//  CRYPTO HELPERS (Web Crypto API — Cloudflare-safe)
// ══════════════════════════════════════════════════
const SALT = 'gaon-dental-salt-2026'
const JWT_SECRET = 'gaon-dental-jwt-secret-2026-secure'
const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000 // 7 days

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password + SALT)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  bytes.forEach(b => bin += String.fromCharCode(b))
  return btoa(bin)
}

function fromBase64(b64: string): string {
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

async function createToken(payload: object): Promise<string> {
  const header = toBase64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = toBase64(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_EXPIRY }))
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`))
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return `${header}.${body}.${signature}`
}

async function verifyToken(token: string): Promise<any> {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, body, signature] = parts
    const enc = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', enc.encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const sigBuf = Uint8Array.from(atob(signature), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBuf, enc.encode(`${header}.${body}`))
    if (!valid) return null
    const payload = JSON.parse(fromBase64(body))
    if (payload.exp < Date.now()) return null
    return payload
  } catch { return null }
}

// Auth middleware
async function auth(c: any, next: any) {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: '인증이 필요합니다' }, 401)
  const payload = await verifyToken(h.slice(7))
  if (!payload) return c.json({ error: '토큰이 만료되었거나 유효하지 않습니다' }, 401)
  c.set('user', payload)
  await next()
}

// ══════════════════════════════════════════════════
//  DATABASE INITIALIZATION
// ══════════════════════════════════════════════════
let dbReady = false
async function initDB(db: D1Database) {
  if (dbReady) return
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      title TEXT DEFAULT '',
      role TEXT DEFAULT '',
      photo_url TEXT,
      photo_key TEXT,
      specialties TEXT DEFAULT '',
      education TEXT DEFAULT '',
      career TEXT DEFAULT '',
      introduction TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT '일반',
      doctor_id INTEGER,
      thumbnail_url TEXT,
      is_published INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS blog_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      filename TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS before_after (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT '임플란트',
      doctor_id INTEGER,
      intraoral_before_url TEXT,
      intraoral_before_key TEXT,
      intraoral_after_url TEXT,
      intraoral_after_key TEXT,
      panorama_before_url TEXT,
      panorama_before_key TEXT,
      panorama_after_url TEXT,
      panorama_after_key TEXT,
      is_published INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      is_pinned INTEGER DEFAULT 0,
      is_published INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    // Notice images (multiple per notice, stored in R2)
    `CREATE TABLE IF NOT EXISTS notice_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notice_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      r2_key TEXT NOT NULL,
      filename TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (notice_id) REFERENCES notices(id) ON DELETE CASCADE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_blog_published ON blog_posts(is_published, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_blog_category ON blog_posts(category)`,
    `CREATE INDEX IF NOT EXISTS idx_blog_images_post ON blog_images(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ba_published ON before_after(is_published, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ba_category ON before_after(category)`,
    `CREATE INDEX IF NOT EXISTS idx_notices_published ON notices(is_published, is_pinned, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_notice_images_notice ON notice_images(notice_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_doctors_active ON doctors(is_active, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_blog_doctor ON blog_posts(doctor_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ba_doctor ON before_after(doctor_id)`,
    // doctor_id columns (safe ALTER — required for production DB that was created without them)
    `ALTER TABLE blog_posts ADD COLUMN doctor_id INTEGER`,
    `ALTER TABLE before_after ADD COLUMN doctor_id INTEGER`,
    `ALTER TABLE blog_posts ADD COLUMN thumbnail_url TEXT`,
    // Fix column name mismatch: migration used image_key, code uses r2_key
    `ALTER TABLE blog_images ADD COLUMN r2_key TEXT DEFAULT ''`,
    `ALTER TABLE blog_images ADD COLUMN filename TEXT DEFAULT ''`,
    `ALTER TABLE notice_images ADD COLUMN r2_key TEXT DEFAULT ''`,
    `ALTER TABLE notice_images ADD COLUMN filename TEXT DEFAULT ''`,
    // view_count columns (safe ALTER — ignore if already exists)
    `ALTER TABLE blog_posts ADD COLUMN view_count INTEGER DEFAULT 0`,
    `ALTER TABLE before_after ADD COLUMN view_count INTEGER DEFAULT 0`,
    `ALTER TABLE notices ADD COLUMN view_count INTEGER DEFAULT 0`,
    // SEO columns for blog (safe ALTER)
    `ALTER TABLE blog_posts ADD COLUMN meta_description TEXT DEFAULT ''`,
    `ALTER TABLE blog_posts ADD COLUMN thumbnail_key TEXT DEFAULT ''`,
    // Members table (일반 회원)
    `CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      privacy_agreed INTEGER DEFAULT 0,
      terms_agreed INTEGER DEFAULT 0,
      marketing_agreed INTEGER DEFAULT 0,
      agreed_at DATETIME,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone)`,
    // Encyclopedia (백과사전)
    `CREATE TABLE IF NOT EXISTS encyclopedia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      category TEXT DEFAULT '일반',
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      faq_q1 TEXT DEFAULT '',
      faq_a1 TEXT DEFAULT '',
      faq_q2 TEXT DEFAULT '',
      faq_a2 TEXT DEFAULT '',
      faq_q3 TEXT DEFAULT '',
      faq_a3 TEXT DEFAULT '',
      related_treatment TEXT DEFAULT '',
      seo_title TEXT DEFAULT '',
      seo_description TEXT DEFAULT '',
      seo_keywords TEXT DEFAULT '',
      is_published INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      view_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_enc_published ON encyclopedia(is_published, sort_order)`,
    `CREATE INDEX IF NOT EXISTS idx_enc_category ON encyclopedia(category)`,
    `CREATE INDEX IF NOT EXISTS idx_enc_slug ON encyclopedia(slug)`,
    // FAQ 4~10 columns (safe ALTER)
    `ALTER TABLE encyclopedia ADD COLUMN faq_q4 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_a4 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_q5 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_a5 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_q6 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_a6 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_q7 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_a7 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_q8 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_a8 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_q9 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_a9 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_q10 TEXT DEFAULT ''`,
    `ALTER TABLE encyclopedia ADD COLUMN faq_a10 TEXT DEFAULT ''`,
  ]
  for (const sql of tables) {
    try { await db.prepare(sql).run() } catch (e: any) {
      // Index already exists is OK
      if (!e.message?.includes('already exists')) console.error('[DB INIT]', e.message)
    }
  }
  dbReady = true
}

// Ensure DB is ready for every API call
app.use('/api/*', async (c, next) => {
  await initDB(c.env.DB)
  await next()
})

// ══════════════════════════════════════════════════
//  HELPER: Safe dynamic query builder
// ══════════════════════════════════════════════════
async function runQuery(db: D1Database, sql: string, binds: any[]) {
  const stmt = db.prepare(sql)
  if (binds.length === 0) return stmt.all()
  // D1 requires explicit bind for each param
  return stmt.bind(...binds).all()
}

async function runFirst(db: D1Database, sql: string, binds: any[]) {
  const stmt = db.prepare(sql)
  if (binds.length === 0) return stmt.first()
  return stmt.bind(...binds).first()
}

// ══════════════════════════════════════════════════
//  R2 IMAGE UPLOAD / SERVE
// ══════════════════════════════════════════════════

// Upload single image to R2
app.post('/api/upload', auth, async (c) => {
  try {
    const r2 = c.env.R2
    const formData = await c.req.formData()
    const file = formData.get('file') as File | null
    if (!file) return c.json({ error: '파일이 없습니다' }, 400)

    const maxSize = 10 * 1024 * 1024 // 10MB
    if (file.size > maxSize) return c.json({ error: '파일 크기는 10MB 이하여야 합니다' }, 400)
    if (!file.type.startsWith('image/')) return c.json({ error: '이미지 파일만 업로드 가능합니다' }, 400)

    const ext = file.name.split('.').pop() || 'jpg'
    const key = `images/${Date.now()}-${Math.random().toString(36).substring(2, 10)}.${ext}`

    const arrayBuf = await file.arrayBuffer()
    await r2.put(key, arrayBuf, {
      httpMetadata: { contentType: file.type },
      customMetadata: { originalName: file.name }
    })

    const url = `/api/images/${key}`
    return c.json({ url, key, filename: file.name, size: file.size })
  } catch (e: any) {
    console.error('[UPLOAD ERROR]', e.message)
    return c.json({ error: '파일 업로드 실패: ' + e.message }, 500)
  }
})

// Upload multiple images at once
app.post('/api/upload/multiple', auth, async (c) => {
  try {
    const r2 = c.env.R2
    const formData = await c.req.formData()
    const files = formData.getAll('files') as File[]
    if (!files.length) return c.json({ error: '파일이 없습니다' }, 400)

    const results = []
    const errors = []
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) { errors.push(`${file.name}: 크기 초과`); continue }
      if (!file.type.startsWith('image/')) { errors.push(`${file.name}: 이미지가 아닙니다`); continue }

      const ext = file.name.split('.').pop() || 'jpg'
      const key = `images/${Date.now()}-${Math.random().toString(36).substring(2, 10)}.${ext}`
      const arrayBuf = await file.arrayBuffer()
      await r2.put(key, arrayBuf, {
        httpMetadata: { contentType: file.type },
        customMetadata: { originalName: file.name }
      })
      results.push({ url: `/api/images/${key}`, key, filename: file.name, size: file.size })
    }

    return c.json({ images: results, count: results.length, errors })
  } catch (e: any) {
    return c.json({ error: '파일 업로드 실패: ' + e.message }, 500)
  }
})

// Serve image from R2 — with Cache API for edge caching
app.get('/api/images/*', async (c) => {
  try {
    const r2 = c.env.R2
    const key = c.req.path.replace('/api/images/', '')
    if (!key) return c.json({ error: 'key 필요' }, 400)

    // 1) Check Cache API first (edge cache — no R2 roundtrip)
    const cacheKey = new Request(c.req.url, { method: 'GET' })
    const cache = caches.default
    let cachedResp = await cache.match(cacheKey)
    if (cachedResp) return cachedResp

    // 2) Not in cache — fetch from R2
    const obj = await r2.get(key)
    if (!obj) return c.notFound()

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg')
    // 브라우저 캐시 1년(immutable) + CF 엣지 캐시 1년 → 첫 방문 후 재방문은 즉시 로딩
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('CDN-Cache-Control', 'public, max-age=31536000, immutable')
    if (obj.etag) headers.set('ETag', obj.etag)
    if (obj.size) headers.set('Content-Length', String(obj.size))

    const resp = new Response(obj.body, { headers })

    // 3) Store in Cache API for future requests (non-blocking)
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()))

    return resp
  } catch (e: any) {
    return c.json({ error: '이미지를 불러올 수 없습니다' }, 404)
  }
})

// Delete image from R2 (internal helper)
async function deleteR2Image(r2: R2Bucket, key: string | null | undefined) {
  if (!key) return
  try { await r2.delete(key) } catch (e) { console.error('[R2 DELETE]', e) }
}

// ══════════════════════════════════════════════════
//  AUTH API — 비밀번호만으로 관리자 인증
// ══════════════════════════════════════════════════
const ADMIN_PASSWORD_HASH_KEY = 'admin_password'

// 관리자 비밀번호 초기 설정 (DB에 없으면 기본값 세팅)
async function ensureAdminPassword(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run()
  const existing = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(ADMIN_PASSWORD_HASH_KEY).first()
  if (!existing) {
    // 기본 비밀번호: gaon2026!
    const defaultHash = await hashPassword('gaon2026!')
    await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(ADMIN_PASSWORD_HASH_KEY, defaultHash).run()
  }
}

// 비밀번호만으로 로그인
app.post('/api/auth/login', async (c) => {
  try {
    const db = c.env.DB
    await ensureAdminPassword(db)
    const { password } = await c.req.json<{ password: string }>()
    if (!password) return c.json({ error: '비밀번호를 입력해주세요' }, 400)

    const hash = await hashPassword(password)
    const stored: any = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(ADMIN_PASSWORD_HASH_KEY).first()
    if (!stored || stored.value !== hash) return c.json({ error: '비밀번호가 올바르지 않습니다' }, 401)

    const token = await createToken({ id: 1, name: '관리자', role: 'admin' })
    return c.json({ token, user: { id: 1, name: '관리자', role: 'admin' } })
  } catch (e: any) {
    return c.json({ error: '로그인 실패: ' + e.message }, 500)
  }
})

app.get('/api/auth/me', auth, async (c) => {
  return c.json({ user: c.get('user') })
})

// 비밀번호 변경
app.put('/api/auth/password', auth, async (c) => {
  try {
    const db = c.env.DB
    await ensureAdminPassword(db)
    const { current_password, new_password } = await c.req.json<{ current_password: string; new_password: string }>()
    if (!current_password || !new_password) return c.json({ error: '현재 비밀번호와 새 비밀번호를 입력해주세요' }, 400)
    if (new_password.length < 4) return c.json({ error: '새 비밀번호는 4자 이상이어야 합니다' }, 400)

    const currentHash = await hashPassword(current_password)
    const stored: any = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(ADMIN_PASSWORD_HASH_KEY).first()
    if (!stored || stored.value !== currentHash) return c.json({ error: '현재 비밀번호가 올바르지 않습니다' }, 401)

    const newHash = await hashPassword(new_password)
    await db.prepare('UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?').bind(newHash, ADMIN_PASSWORD_HASH_KEY).run()
    return c.json({ message: '비밀번호가 변경되었습니다' })
  } catch (e: any) {
    return c.json({ error: '비밀번호 변경 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  MEMBER AUTH API — 일반 회원 가입/로그인
// ══════════════════════════════════════════════════

// 회원가입
app.post('/api/member/signup', async (c) => {
  try {
    const db = c.env.DB
    const { name, phone, password, privacy_agreed, terms_agreed, marketing_agreed } = await c.req.json<{
      name: string; phone: string; password: string;
      privacy_agreed?: boolean; terms_agreed?: boolean; marketing_agreed?: boolean;
    }>()
    if (!name?.trim()) return c.json({ error: '이름을 입력해주세요' }, 400)
    if (!phone?.trim()) return c.json({ error: '전화번호를 입력해주세요' }, 400)
    if (!password || password.length < 4) return c.json({ error: '비밀번호는 4자 이상이어야 합니다' }, 400)
    if (!privacy_agreed) return c.json({ error: '개인정보 수집 및 이용에 동의해주세요' }, 400)
    if (!terms_agreed) return c.json({ error: '이용약관에 동의해주세요' }, 400)

    // 전화번호 정규화 (숫자만 추출)
    const cleanPhone = phone.replace(/[^0-9]/g, '')
    if (cleanPhone.length < 10 || cleanPhone.length > 11) return c.json({ error: '올바른 전화번호를 입력해주세요' }, 400)

    // 중복 체크
    const existing = await db.prepare('SELECT id FROM members WHERE phone = ?').bind(cleanPhone).first()
    if (existing) return c.json({ error: '이미 가입된 전화번호입니다' }, 409)

    const hash = await hashPassword(password)
    const result = await db.prepare(
      'INSERT INTO members (name, phone, password_hash, privacy_agreed, terms_agreed, marketing_agreed, agreed_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).bind(name.trim(), cleanPhone, hash, privacy_agreed ? 1 : 0, terms_agreed ? 1 : 0, marketing_agreed ? 1 : 0).run()

    const memberId = result.meta.last_row_id
    const token = await createToken({ id: memberId, name: name.trim(), phone: cleanPhone, role: 'member' })
    return c.json({ token, user: { id: memberId, name: name.trim(), phone: cleanPhone, role: 'member' } }, 201)
  } catch (e: any) {
    return c.json({ error: '회원가입 실패: ' + e.message }, 500)
  }
})

// 회원 로그인
app.post('/api/member/login', async (c) => {
  try {
    const db = c.env.DB
    const { phone, password } = await c.req.json<{ phone: string; password: string }>()
    if (!phone?.trim()) return c.json({ error: '전화번호를 입력해주세요' }, 400)
    if (!password) return c.json({ error: '비밀번호를 입력해주세요' }, 400)

    const cleanPhone = phone.replace(/[^0-9]/g, '')
    const hash = await hashPassword(password)
    const member: any = await db.prepare(
      'SELECT id, name, phone, is_active FROM members WHERE phone = ? AND password_hash = ?'
    ).bind(cleanPhone, hash).first()

    if (!member) return c.json({ error: '전화번호 또는 비밀번호가 올바르지 않습니다' }, 401)
    if (!member.is_active) return c.json({ error: '비활성화된 계정입니다. 관리자에게 문의하세요.' }, 403)

    const token = await createToken({ id: member.id, name: member.name, phone: member.phone, role: 'member' })
    return c.json({ token, user: { id: member.id, name: member.name, phone: member.phone, role: 'member' } })
  } catch (e: any) {
    return c.json({ error: '로그인 실패: ' + e.message }, 500)
  }
})

// 회원 정보 확인
app.get('/api/member/me', auth, async (c) => {
  const user = c.get('user')
  if (user.role !== 'member') return c.json({ error: '회원 전용 API입니다' }, 403)
  return c.json({ user })
})

// ══════════════════════════════════════════════════
//  ADMIN: MEMBER MANAGEMENT API
// ══════════════════════════════════════════════════

// 회원 목록 (관리자)
app.get('/api/admin/members', auth, async (c) => {
  try {
    const db = c.env.DB
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')))
    const search = c.req.query('search')
    const marketing = c.req.query('marketing') // 'yes' or 'no'
    const offset = (page - 1) * limit

    let whereParts: string[] = []
    const binds: any[] = []
    if (search) {
      whereParts.push('(name LIKE ? OR phone LIKE ?)')
      binds.push(`%${search}%`, `%${search}%`)
    }
    if (marketing === 'yes') { whereParts.push('marketing_agreed = 1') }
    else if (marketing === 'no') { whereParts.push('marketing_agreed = 0') }

    const where = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : ''
    const dataSql = `SELECT id, name, phone, privacy_agreed, terms_agreed, marketing_agreed, agreed_at, is_active, created_at FROM members ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as total FROM members ${where}`

    const members = await runQuery(db, dataSql, [...binds, limit, offset])
    const countResult: any = await runFirst(db, countSql, binds)
    const total = countResult?.total || 0

    // Stats
    const stats: any = await db.prepare(`SELECT
      COUNT(*) as total,
      SUM(CASE WHEN marketing_agreed = 1 THEN 1 ELSE 0 END) as marketing_yes,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active
    FROM members`).first()

    return c.json({
      members: members.results || [],
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      stats: { total: stats?.total || 0, marketing_yes: stats?.marketing_yes || 0, active: stats?.active || 0 }
    })
  } catch (e: any) {
    return c.json({ error: '회원 목록 조회 실패: ' + e.message }, 500)
  }
})

// 회원 상세 (관리자)
app.get('/api/admin/members/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const member = await db.prepare('SELECT id, name, phone, privacy_agreed, terms_agreed, marketing_agreed, agreed_at, is_active, created_at FROM members WHERE id = ?').bind(id).first()
    if (!member) return c.json({ error: '회원을 찾을 수 없습니다' }, 404)
    return c.json({ member })
  } catch (e: any) {
    return c.json({ error: '회원 조회 실패: ' + e.message }, 500)
  }
})

// 회원 상태 변경 (활성/비활성)
app.put('/api/admin/members/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const { is_active } = await c.req.json<{ is_active: number }>()
    await db.prepare('UPDATE members SET is_active = ? WHERE id = ?').bind(is_active, id).run()
    return c.json({ message: is_active ? '회원이 활성화되었습니다' : '회원이 비활성화되었습니다' })
  } catch (e: any) {
    return c.json({ error: '회원 상태 변경 실패: ' + e.message }, 500)
  }
})

// 회원 삭제 (관리자)
app.delete('/api/admin/members/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    await db.prepare('DELETE FROM members WHERE id = ?').bind(id).run()
    return c.json({ message: '회원이 삭제되었습니다' })
  } catch (e: any) {
    return c.json({ error: '회원 삭제 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  DOCTORS API — PUBLIC
// ══════════════════════════════════════════════════

app.get('/api/doctors', async (c) => {
  try {
    const db = c.env.DB
    const doctors = await db.prepare('SELECT id, name, title, role, photo_url, specialties, education, career, introduction, sort_order FROM doctors WHERE is_active = 1 ORDER BY sort_order, id').all()
    return c.json({ doctors: doctors.results || [] })
  } catch (e: any) {
    return c.json({ error: '의료진 목록 조회 실패: ' + e.message }, 500)
  }
})

app.get('/api/doctors/:id', async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const doctor = await db.prepare('SELECT * FROM doctors WHERE id = ? AND is_active = 1').bind(id).first()
    if (!doctor) return c.json({ error: '의료진을 찾을 수 없습니다' }, 404)
    // Get their blog posts & cases
    const blogs = await db.prepare(`SELECT id, title, category, thumbnail_url, created_at FROM blog_posts WHERE doctor_id = ? AND is_published = 1 AND id NOT IN (${BLOG_DUPLICATE_IDS_SQL}) ORDER BY created_at DESC LIMIT 10`).bind(id).all()
    const cases = await db.prepare('SELECT id, title, category, intraoral_before_url, intraoral_after_url, panorama_before_url, panorama_after_url, created_at FROM before_after WHERE doctor_id = ? AND is_published = 1 ORDER BY created_at DESC LIMIT 10').bind(id).all()
    return c.json({ doctor, blogs: blogs.results || [], cases: cases.results || [] })
  } catch (e: any) {
    return c.json({ error: '의료진 조회 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  DOCTORS API — ADMIN
// ══════════════════════════════════════════════════

app.post('/api/admin/doctors', auth, async (c) => {
  try {
    const db = c.env.DB
    const body = await c.req.json<{
      name: string; title?: string; role?: string;
      photo?: { url: string; key: string };
      specialties?: string; education?: string; career?: string; introduction?: string; sort_order?: number;
    }>()
    if (!body.name?.trim()) return c.json({ error: '이름을 입력해주세요' }, 400)
    const result = await db.prepare(
      `INSERT INTO doctors (name, title, role, photo_url, photo_key, specialties, education, career, introduction, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      body.name.trim(), body.title || '', body.role || '',
      body.photo?.url || null, body.photo?.key || null,
      body.specialties || '', body.education || '', body.career || '', body.introduction || '',
      body.sort_order ?? 0
    ).run()
    return c.json({ id: result.meta.last_row_id, message: '의료진이 등록되었습니다' }, 201)
  } catch (e: any) {
    return c.json({ error: '의료진 등록 실패: ' + e.message }, 500)
  }
})

app.put('/api/admin/doctors/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const r2 = c.env.R2
    const id = c.req.param('id')
    const body = await c.req.json<{
      name?: string; title?: string; role?: string;
      photo?: { url: string; key: string } | null;
      specialties?: string; education?: string; career?: string; introduction?: string;
      sort_order?: number; is_active?: number;
    }>()
    const existing: any = await db.prepare('SELECT * FROM doctors WHERE id = ?').bind(id).first()
    if (!existing) return c.json({ error: '의료진을 찾을 수 없습니다' }, 404)

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
    const vals: any[] = []
    if (body.name !== undefined) { sets.push('name = ?'); vals.push(body.name.trim()) }
    if (body.title !== undefined) { sets.push('title = ?'); vals.push(body.title) }
    if (body.role !== undefined) { sets.push('role = ?'); vals.push(body.role) }
    if (body.specialties !== undefined) { sets.push('specialties = ?'); vals.push(body.specialties) }
    if (body.education !== undefined) { sets.push('education = ?'); vals.push(body.education) }
    if (body.career !== undefined) { sets.push('career = ?'); vals.push(body.career) }
    if (body.introduction !== undefined) { sets.push('introduction = ?'); vals.push(body.introduction) }
    if (body.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(body.sort_order) }
    if (body.is_active !== undefined) { sets.push('is_active = ?'); vals.push(body.is_active) }
    if (body.photo !== undefined) {
      if (existing.photo_key && (!body.photo || body.photo.key !== existing.photo_key)) {
        await deleteR2Image(r2, existing.photo_key)
      }
      sets.push('photo_url = ?'); vals.push(body.photo?.url || null)
      sets.push('photo_key = ?'); vals.push(body.photo?.key || null)
    }
    vals.push(id)
    await db.prepare(`UPDATE doctors SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()
    return c.json({ message: '의료진 정보가 수정되었습니다' })
  } catch (e: any) {
    return c.json({ error: '의료진 수정 실패: ' + e.message }, 500)
  }
})

app.get('/api/admin/doctors', auth, async (c) => {
  try {
    const db = c.env.DB
    const doctors = await db.prepare('SELECT * FROM doctors ORDER BY sort_order, id').all()
    return c.json({ doctors: doctors.results || [] })
  } catch (e: any) {
    return c.json({ error: '목록 조회 실패: ' + e.message }, 500)
  }
})

app.delete('/api/admin/doctors/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const r2 = c.env.R2
    const id = c.req.param('id')
    const existing: any = await db.prepare('SELECT photo_key FROM doctors WHERE id = ?').bind(id).first()
    if (existing?.photo_key) await deleteR2Image(r2, existing.photo_key)
    // Nullify references
    await db.prepare('UPDATE blog_posts SET doctor_id = NULL WHERE doctor_id = ?').bind(id).run()
    await db.prepare('UPDATE before_after SET doctor_id = NULL WHERE doctor_id = ?').bind(id).run()
    await db.prepare('DELETE FROM doctors WHERE id = ?').bind(id).run()
    return c.json({ message: '삭제되었습니다' })
  } catch (e: any) {
    return c.json({ error: '삭제 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  BLOG API — PUBLIC
// ══════════════════════════════════════════════════

// List published blogs (with pagination + search + doctor join)
app.get('/api/blog', async (c) => {
  try {
    const db = c.env.DB
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
    const category = c.req.query('category')
    const search = c.req.query('search')
    const doctorId = c.req.query('doctor_id')
    const offset = (page - 1) * limit

    let whereParts = ['b.is_published = 1', `b.id NOT IN (${BLOG_DUPLICATE_IDS_SQL})`]
    const binds: any[] = []

    if (category) { whereParts.push('b.category = ?'); binds.push(category) }
    if (search) { whereParts.push('(b.title LIKE ? OR b.content LIKE ?)'); binds.push(`%${search}%`, `%${search}%`) }
    if (doctorId) { whereParts.push('b.doctor_id = ?'); binds.push(doctorId) }

    const where = whereParts.join(' AND ')
    const dataSql = `SELECT b.id, b.title, b.content, b.category, b.doctor_id, b.thumbnail_url, b.view_count, b.created_at, d.name as doctor_name, d.photo_url as doctor_photo FROM blog_posts b LEFT JOIN doctors d ON b.doctor_id = d.id WHERE ${where} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as total FROM blog_posts b WHERE ${where.replace(/d\./g, '').replace(/LEFT JOIN.*?WHERE/, 'WHERE')}`
    // Simpler count
    let countWhereParts = ['is_published = 1', `id NOT IN (${BLOG_DUPLICATE_IDS_SQL})`]
    const countBinds: any[] = []
    if (category) { countWhereParts.push('category = ?'); countBinds.push(category) }
    if (search) { countWhereParts.push('(title LIKE ? OR content LIKE ?)'); countBinds.push(`%${search}%`, `%${search}%`) }
    if (doctorId) { countWhereParts.push('doctor_id = ?'); countBinds.push(doctorId) }
    const countSqlClean = `SELECT COUNT(*) as total FROM blog_posts WHERE ${countWhereParts.join(' AND ')}`

    const posts = await runQuery(db, dataSql, [...binds, limit, offset])
    const countResult: any = await runFirst(db, countSqlClean, countBinds)
    const total = countResult?.total || 0

    return c.json({
      posts: posts.results || [],
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    })
  } catch (e: any) {
    return c.json({ error: '블로그 목록 조회 실패: ' + e.message }, 500)
  }
})

// Get single blog with images + doctor info
app.get('/api/blog/:id', async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const post: any = await db.prepare('SELECT b.*, d.name as doctor_name, d.photo_url as doctor_photo, d.title as doctor_title, d.role as doctor_role FROM blog_posts b LEFT JOIN doctors d ON b.doctor_id = d.id WHERE b.id = ? AND b.is_published = 1').bind(id).first()
    if (!post) return c.json({ error: '게시글을 찾을 수 없습니다' }, 404)

    // Increment view count
    await db.prepare('UPDATE blog_posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?').bind(id).run()

    let images: any = { results: [] }
    try {
      images = await db.prepare('SELECT id, image_url, COALESCE(r2_key, image_key, \'\') as r2_key, COALESCE(filename, \'\') as filename, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all()
    } catch {
      try { images = await db.prepare('SELECT id, image_url, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all() } catch {}
    }
    return c.json({ post: { ...post, view_count: (post.view_count || 0) + 1 }, images: images.results || [] })
  } catch (e: any) {
    return c.json({ error: '게시글 조회 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  BLOG API — ADMIN
// ══════════════════════════════════════════════════

// Create blog (HTML content from SEO block editor)
app.post('/api/admin/blog', auth, async (c) => {
  try {
    const db = c.env.DB
    const { title, content, category, doctor_id, thumbnail_url, meta_description } = await c.req.json<{
      title: string; content: string; category?: string; doctor_id?: number | null;
      thumbnail_url?: string | null; meta_description?: string;
    }>()
    if (!title?.trim()) return c.json({ error: '제목을 입력해주세요' }, 400)
    if (!content?.trim()) return c.json({ error: '내용을 입력해주세요' }, 400)

    const result = await db.prepare(
      'INSERT INTO blog_posts (title, content, category, doctor_id, thumbnail_url, meta_description) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(title.trim(), content.trim(), category || '일반', doctor_id || null, thumbnail_url || null, meta_description || '').run()
    const postId = result.meta.last_row_id

    // IndexNow: 새 블로그 포스트 색인 요청
    c.executionCtx.waitUntil(submitIndexNow([`https://seoulgaondc.kr/blog/${postId}`, 'https://seoulgaondc.kr/blog', 'https://seoulgaondc.kr/sitemap.xml']))

    return c.json({ id: postId, message: '블로그 게시글이 등록되었습니다' }, 201)
  } catch (e: any) {
    return c.json({ error: '블로그 등록 실패: ' + e.message }, 500)
  }
})

// Update blog
app.put('/api/admin/blog/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const r2 = c.env.R2
    const id = c.req.param('id')
    const { title, content, category, doctor_id, is_published, thumbnail_url, meta_description } = await c.req.json<{
      title?: string; content?: string; category?: string; doctor_id?: number | null; is_published?: number;
      thumbnail_url?: string | null; meta_description?: string;
    }>()

    const existing = await db.prepare('SELECT id FROM blog_posts WHERE id = ?').bind(id).first()
    if (!existing) return c.json({ error: '게시글을 찾을 수 없습니다' }, 404)

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
    const vals: any[] = []
    if (title !== undefined) { sets.push('title = ?'); vals.push(title.trim()) }
    if (content !== undefined) { sets.push('content = ?'); vals.push(content.trim()) }
    if (category !== undefined) { sets.push('category = ?'); vals.push(category) }
    if (doctor_id !== undefined) { sets.push('doctor_id = ?'); vals.push(doctor_id) }
    if (is_published !== undefined) { sets.push('is_published = ?'); vals.push(is_published) }
    if (thumbnail_url !== undefined) { sets.push('thumbnail_url = ?'); vals.push(thumbnail_url) }
    if (meta_description !== undefined) { sets.push('meta_description = ?'); vals.push(meta_description) }

    vals.push(id)
    await db.prepare(`UPDATE blog_posts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()

    // IndexNow: 수정된 블로그 포스트 재색인 요청
    c.executionCtx.waitUntil(submitIndexNow([`https://seoulgaondc.kr/blog/${id}`, 'https://seoulgaondc.kr/blog']))

    return c.json({ message: '게시글이 수정되었습니다' })
  } catch (e: any) {
    return c.json({ error: '게시글 수정 실패: ' + e.message }, 500)
  }
})

// List all blogs (admin with pagination + search)
app.get('/api/admin/blog', auth, async (c) => {
  try {
    const db = c.env.DB
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')))
    const search = c.req.query('search')
    const offset = (page - 1) * limit

    let whereParts: string[] = []
    const binds: any[] = []
    if (search) {
      whereParts.push('(title LIKE ? OR content LIKE ?)')
      binds.push(`%${search}%`, `%${search}%`)
    }

    const where = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : ''
    const dataSql = `SELECT b.*, d.name as doctor_name FROM blog_posts b LEFT JOIN doctors d ON b.doctor_id = d.id ${where.replace(/\b(title|content|created_at|is_published|category)\b/g, 'b.$1')} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as total FROM blog_posts ${where}`

    const posts = await runQuery(db, dataSql, [...binds, limit, offset])
    const countResult: any = await runFirst(db, countSql, binds)

    return c.json({
      posts: posts.results || [],
      pagination: { page, limit, total: countResult?.total || 0, pages: Math.ceil((countResult?.total || 0) / limit) }
    })
  } catch (e: any) {
    return c.json({ error: '목록 조회 실패: ' + e.message }, 500)
  }
})

// Get single blog (admin — includes unpublished, with doctor info)
app.get('/api/admin/blog/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const post = await db.prepare('SELECT b.*, d.name as doctor_name, d.photo_url as doctor_photo, d.title as doctor_title FROM blog_posts b LEFT JOIN doctors d ON b.doctor_id = d.id WHERE b.id = ?').bind(id).first()
    if (!post) return c.json({ error: '게시글을 찾을 수 없습니다' }, 404)

    let images: any = { results: [] }
    try {
      images = await db.prepare('SELECT id, image_url, COALESCE(r2_key, image_key, \'\') as r2_key, COALESCE(filename, \'\') as filename, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all()
    } catch {
      try { images = await db.prepare('SELECT id, image_url, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all() } catch {}
    }
    return c.json({ post, images: images.results || [] })
  } catch (e: any) {
    return c.json({ error: '게시글 조회 실패: ' + e.message }, 500)
  }
})

// Delete blog + R2 cleanup
app.delete('/api/admin/blog/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const r2 = c.env.R2
    const id = c.req.param('id')

    let images: any = { results: [] }
    try { images = await db.prepare('SELECT COALESCE(r2_key, image_key, \'\') as r2_key FROM blog_images WHERE post_id = ?').bind(id).all() } catch {
      try { images = await db.prepare('SELECT image_key as r2_key FROM blog_images WHERE post_id = ?').bind(id).all() } catch {}
    }
    for (const img of (images.results || []) as any[]) {
      if (img.r2_key) await deleteR2Image(r2, img.r2_key)
    }

    await db.prepare('DELETE FROM blog_images WHERE post_id = ?').bind(id).run()
    await db.prepare('DELETE FROM blog_posts WHERE id = ?').bind(id).run()
    return c.json({ message: '삭제되었습니다' })
  } catch (e: any) {
    return c.json({ error: '삭제 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  BEFORE & AFTER API — PUBLIC
// ══════════════════════════════════════════════════

app.get('/api/before-after', async (c) => {
  try {
    const db = c.env.DB
    const category = c.req.query('category')
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '100')))
    const offset = (page - 1) * limit

    let whereParts = ['ba.is_published = 1']
    const binds: any[] = []
    const doctorId = c.req.query('doctor_id')

    if (category) { whereParts.push('ba.category = ?'); binds.push(category) }
    if (doctorId) { whereParts.push('ba.doctor_id = ?'); binds.push(doctorId) }

    const where = whereParts.join(' AND ')
    const dataSql = `SELECT ba.id, ba.title, ba.description, ba.category, ba.doctor_id,
      ba.intraoral_before_url, ba.intraoral_after_url, ba.panorama_before_url, ba.panorama_after_url,
      ba.created_at, d.name as doctor_name, d.photo_url as doctor_photo
      FROM before_after ba LEFT JOIN doctors d ON ba.doctor_id = d.id WHERE ${where} ORDER BY ba.created_at DESC LIMIT ? OFFSET ?`
    let countWhereParts2 = ['is_published = 1']
    const countBinds2: any[] = []
    if (category) { countWhereParts2.push('category = ?'); countBinds2.push(category) }
    if (doctorId) { countWhereParts2.push('doctor_id = ?'); countBinds2.push(doctorId) }
    const countSql = `SELECT COUNT(*) as total FROM before_after WHERE ${countWhereParts2.join(' AND ')}`

    const cases = await runQuery(db, dataSql, [...binds, limit, offset])
    const countResult: any = await runFirst(db, countSql, countBinds2)
    const total = countResult?.total || 0

    return c.json({
      cases: cases.results || [],
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    })
  } catch (e: any) {
    return c.json({ error: '케이스 목록 조회 실패: ' + e.message }, 500)
  }
})

app.get('/api/before-after/:id', async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const item = await db.prepare(
      `SELECT ba.*, d.name as doctor_name, d.photo_url as doctor_photo, d.title as doctor_title
        FROM before_after ba LEFT JOIN doctors d ON ba.doctor_id = d.id
        WHERE ba.id = ? AND ba.is_published = 1`
    ).bind(id).first()
    if (!item) return c.json({ error: '케이스를 찾을 수 없습니다' }, 404)

    // Increment view count
    await db.prepare('UPDATE before_after SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?').bind(id).run()

    return c.json({ case: { ...(item as any), view_count: ((item as any).view_count || 0) + 1 } })
  } catch (e: any) {
    return c.json({ error: '케이스 조회 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  BEFORE & AFTER API — ADMIN
// ══════════════════════════════════════════════════

app.post('/api/admin/before-after', auth, async (c) => {
  try {
    const db = c.env.DB
    const body = await c.req.json<{
      title: string; description?: string; category?: string; doctor_id?: number | null;
      intraoral_before?: { url: string; key: string };
      intraoral_after?: { url: string; key: string };
      panorama_before?: { url: string; key: string };
      panorama_after?: { url: string; key: string };
    }>()
    if (!body.title?.trim()) return c.json({ error: '제목을 입력해주세요' }, 400)

    const result = await db.prepare(`
      INSERT INTO before_after (title, description, category, doctor_id,
        intraoral_before_url, intraoral_before_key, intraoral_after_url, intraoral_after_key,
        panorama_before_url, panorama_before_key, panorama_after_url, panorama_after_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.title.trim(), body.description || '', body.category || '임플란트', body.doctor_id || null,
      body.intraoral_before?.url || null, body.intraoral_before?.key || null,
      body.intraoral_after?.url || null, body.intraoral_after?.key || null,
      body.panorama_before?.url || null, body.panorama_before?.key || null,
      body.panorama_after?.url || null, body.panorama_after?.key || null,
    ).run()

    const caseId = result.meta.last_row_id
    // IndexNow: 새 BA 케이스 색인 요청
    c.executionCtx.waitUntil(submitIndexNow(['https://seoulgaondc.kr/before-after', 'https://seoulgaondc.kr/sitemap.xml']))

    return c.json({ id: caseId, message: '비포&애프터 케이스가 등록되었습니다' }, 201)
  } catch (e: any) {
    return c.json({ error: '케이스 등록 실패: ' + e.message }, 500)
  }
})

app.put('/api/admin/before-after/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const r2 = c.env.R2
    const id = c.req.param('id')
    const body = await c.req.json<{
      title?: string; description?: string; category?: string; doctor_id?: number | null; is_published?: number;
      intraoral_before?: { url: string; key: string } | null;
      intraoral_after?: { url: string; key: string } | null;
      panorama_before?: { url: string; key: string } | null;
      panorama_after?: { url: string; key: string } | null;
    }>()

    const existing: any = await db.prepare('SELECT * FROM before_after WHERE id = ?').bind(id).first()
    if (!existing) return c.json({ error: '케이스를 찾을 수 없습니다' }, 404)

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
    const vals: any[] = []

    if (body.title !== undefined) { sets.push('title = ?'); vals.push(body.title.trim()) }
    if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description) }
    if (body.category !== undefined) { sets.push('category = ?'); vals.push(body.category) }
    if (body.doctor_id !== undefined) { sets.push('doctor_id = ?'); vals.push(body.doctor_id) }
    if (body.is_published !== undefined) { sets.push('is_published = ?'); vals.push(body.is_published) }

    // Handle image slot updates — delete old R2 if changed
    const slots = ['intraoral_before', 'intraoral_after', 'panorama_before', 'panorama_after'] as const
    for (const slot of slots) {
      if (body[slot] !== undefined) {
        const oldKey = existing[`${slot}_key`]
        if (oldKey && (!body[slot] || body[slot]!.key !== oldKey)) {
          await deleteR2Image(r2, oldKey)
        }
        sets.push(`${slot}_url = ?`); vals.push(body[slot]?.url || null)
        sets.push(`${slot}_key = ?`); vals.push(body[slot]?.key || null)
      }
    }

    vals.push(id)
    await db.prepare(`UPDATE before_after SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()

    // IndexNow: 수정된 BA 케이스 재색인 요청
    c.executionCtx.waitUntil(submitIndexNow(['https://seoulgaondc.kr/before-after']))

    return c.json({ message: '케이스가 수정되었습니다' })
  } catch (e: any) {
    return c.json({ error: '케이스 수정 실패: ' + e.message }, 500)
  }
})

app.get('/api/admin/before-after', auth, async (c) => {
  try {
    const db = c.env.DB
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(500, Math.max(1, parseInt(c.req.query('limit') || '200')))
    const offset = (page - 1) * limit

    const cases = await db.prepare('SELECT * FROM before_after ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all()
    const countResult: any = await db.prepare('SELECT COUNT(*) as total FROM before_after').first()

    return c.json({
      cases: cases.results || [],
      pagination: { page, limit, total: countResult?.total || 0, pages: Math.ceil((countResult?.total || 0) / limit) }
    })
  } catch (e: any) {
    return c.json({ error: '목록 조회 실패: ' + e.message }, 500)
  }
})

app.get('/api/admin/before-after/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const item = await db.prepare('SELECT ba.*, d.name as doctor_name, d.photo_url as doctor_photo FROM before_after ba LEFT JOIN doctors d ON ba.doctor_id = d.id WHERE ba.id = ?').bind(id).first()
    if (!item) return c.json({ error: '케이스를 찾을 수 없습니다' }, 404)
    return c.json({ case: item })
  } catch (e: any) {
    return c.json({ error: '케이스 조회 실패: ' + e.message }, 500)
  }
})

app.delete('/api/admin/before-after/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const r2 = c.env.R2
    const id = c.req.param('id')

    const existing: any = await db.prepare('SELECT * FROM before_after WHERE id = ?').bind(id).first()
    if (existing) {
      await deleteR2Image(r2, existing.intraoral_before_key)
      await deleteR2Image(r2, existing.intraoral_after_key)
      await deleteR2Image(r2, existing.panorama_before_key)
      await deleteR2Image(r2, existing.panorama_after_key)
    }

    await db.prepare('DELETE FROM before_after WHERE id = ?').bind(id).run()
    return c.json({ message: '삭제되었습니다' })
  } catch (e: any) {
    return c.json({ error: '삭제 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  NOTICES API — PUBLIC
// ══════════════════════════════════════════════════

app.get('/api/notices', async (c) => {
  try {
    const db = c.env.DB
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')))
    const offset = (page - 1) * limit

    const notices = await db.prepare(
      'SELECT * FROM notices WHERE is_published = 1 ORDER BY is_pinned DESC, created_at DESC LIMIT ? OFFSET ?'
    ).bind(limit, offset).all()
    const countResult: any = await db.prepare('SELECT COUNT(*) as total FROM notices WHERE is_published = 1').first()

    return c.json({
      notices: notices.results || [],
      pagination: { page, limit, total: countResult?.total || 0 }
    })
  } catch (e: any) {
    return c.json({ error: '공지 목록 조회 실패: ' + e.message }, 500)
  }
})

app.get('/api/notices/:id', async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const notice: any = await db.prepare('SELECT * FROM notices WHERE id = ? AND is_published = 1').bind(id).first()
    if (!notice) return c.json({ error: '공지사항을 찾을 수 없습니다' }, 404)

    // Increment view count
    await db.prepare('UPDATE notices SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?').bind(id).run()

    let images: any = { results: [] }
    try {
      images = await db.prepare('SELECT id, image_url, COALESCE(r2_key, image_key, \'\') as r2_key, COALESCE(filename, \'\') as filename, sort_order FROM notice_images WHERE notice_id = ? ORDER BY sort_order').bind(id).all()
    } catch {
      try { images = await db.prepare('SELECT id, image_url, sort_order FROM notice_images WHERE notice_id = ? ORDER BY sort_order').bind(id).all() } catch {}
    }
    return c.json({ notice: { ...notice, view_count: (notice.view_count || 0) + 1 }, images: images.results || [] })
  } catch (e: any) {
    return c.json({ error: '공지 조회 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  NOTICES API — ADMIN
// ══════════════════════════════════════════════════

app.post('/api/admin/notices', auth, async (c) => {
  try {
    const db = c.env.DB
    const { title, content, is_pinned, images } = await c.req.json<{
      title: string; content: string; is_pinned?: boolean;
      images?: { url: string; key: string; name: string }[]
    }>()
    if (!title?.trim()) return c.json({ error: '제목을 입력해주세요' }, 400)
    if (!content?.trim()) return c.json({ error: '내용을 입력해주세요' }, 400)

    const result = await db.prepare('INSERT INTO notices (title, content, is_pinned) VALUES (?, ?, ?)')
      .bind(title.trim(), content.trim(), is_pinned ? 1 : 0).run()
    const noticeId = result.meta.last_row_id

    // Link images to notice
    if (images?.length) {
      for (let i = 0; i < images.length; i++) {
        await db.prepare(
          'INSERT INTO notice_images (notice_id, image_url, r2_key, filename, sort_order) VALUES (?, ?, ?, ?, ?)'
        ).bind(noticeId, images[i].url, images[i].key, images[i].name || '', i).run()
      }
    }

    return c.json({ id: noticeId, message: '공지사항이 등록되었습니다' }, 201)
  } catch (e: any) {
    return c.json({ error: '공지 등록 실패: ' + e.message }, 500)
  }
})

app.put('/api/admin/notices/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const r2 = c.env.R2
    const id = c.req.param('id')
    const { title, content, is_pinned, is_published, images } = await c.req.json<{
      title?: string; content?: string; is_pinned?: boolean; is_published?: number;
      images?: { url: string; key: string; name: string }[]
    }>()

    const existing = await db.prepare('SELECT id FROM notices WHERE id = ?').bind(id).first()
    if (!existing) return c.json({ error: '공지사항을 찾을 수 없습니다' }, 404)

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
    const vals: any[] = []
    if (title !== undefined) { sets.push('title = ?'); vals.push(title.trim()) }
    if (content !== undefined) { sets.push('content = ?'); vals.push(content.trim()) }
    if (is_pinned !== undefined) { sets.push('is_pinned = ?'); vals.push(is_pinned ? 1 : 0) }
    if (is_published !== undefined) { sets.push('is_published = ?'); vals.push(is_published) }

    vals.push(id)
    await db.prepare(`UPDATE notices SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()

    // Replace images if provided
    if (images !== undefined) {
      let oldImages: any = { results: [] }
      try { oldImages = await db.prepare('SELECT COALESCE(r2_key, image_key, \'\') as r2_key FROM notice_images WHERE notice_id = ?').bind(id).all() } catch {
        try { oldImages = await db.prepare('SELECT image_key as r2_key FROM notice_images WHERE notice_id = ?').bind(id).all() } catch {}
      }
      const newKeys = new Set(images.map(i => i.key))
      for (const img of (oldImages.results || []) as any[]) {
        if (img.r2_key && !newKeys.has(img.r2_key)) {
          await deleteR2Image(r2, img.r2_key)
        }
      }
      await db.prepare('DELETE FROM notice_images WHERE notice_id = ?').bind(id).run()

      for (let i = 0; i < images.length; i++) {
        await db.prepare(
          'INSERT INTO notice_images (notice_id, image_url, r2_key, filename, sort_order) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, images[i].url, images[i].key, images[i].name || '', i).run()
      }
    }

    return c.json({ message: '공지사항이 수정되었습니다' })
  } catch (e: any) {
    return c.json({ error: '공지 수정 실패: ' + e.message }, 500)
  }
})

app.get('/api/admin/notices', auth, async (c) => {
  try {
    const db = c.env.DB
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')))
    const offset = (page - 1) * limit

    const notices = await db.prepare('SELECT * FROM notices ORDER BY is_pinned DESC, created_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all()
    const countResult: any = await db.prepare('SELECT COUNT(*) as total FROM notices').first()

    return c.json({
      notices: notices.results || [],
      pagination: { page, limit, total: countResult?.total || 0, pages: Math.ceil((countResult?.total || 0) / limit) }
    })
  } catch (e: any) {
    return c.json({ error: '목록 조회 실패: ' + e.message }, 500)
  }
})

// Get single notice (admin — with images)
app.get('/api/admin/notices/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const notice = await db.prepare('SELECT * FROM notices WHERE id = ?').bind(id).first()
    if (!notice) return c.json({ error: '공지사항을 찾을 수 없습니다' }, 404)
    let images: any = { results: [] }
    try {
      images = await db.prepare('SELECT id, image_url, COALESCE(r2_key, image_key, \'\') as r2_key, COALESCE(filename, \'\') as filename, sort_order FROM notice_images WHERE notice_id = ? ORDER BY sort_order').bind(id).all()
    } catch {
      try { images = await db.prepare('SELECT id, image_url, sort_order FROM notice_images WHERE notice_id = ? ORDER BY sort_order').bind(id).all() } catch {}
    }
    return c.json({ notice, images: images.results || [] })
  } catch (e: any) {
    return c.json({ error: '공지 조회 실패: ' + e.message }, 500)
  }
})

app.delete('/api/admin/notices/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const r2 = c.env.R2
    const id = c.req.param('id')

    // Delete R2 images first
    let images: any = { results: [] }
    try { images = await db.prepare('SELECT COALESCE(r2_key, image_key, \'\') as r2_key FROM notice_images WHERE notice_id = ?').bind(id).all() } catch {
      try { images = await db.prepare('SELECT image_key as r2_key FROM notice_images WHERE notice_id = ?').bind(id).all() } catch {}
    }
    for (const img of (images.results || []) as any[]) {
      if (img.r2_key) await deleteR2Image(r2, img.r2_key)
    }
    await db.prepare('DELETE FROM notice_images WHERE notice_id = ?').bind(id).run()
    await db.prepare('DELETE FROM notices WHERE id = ?').bind(id).run()
    return c.json({ message: '삭제되었습니다' })
  } catch (e: any) {
    return c.json({ error: '삭제 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  DASHBOARD STATS
// ══════════════════════════════════════════════════
app.get('/api/admin/stats', auth, async (c) => {
  try {
    const db = c.env.DB
    const [blogs, cases, notices, users, doctors, members, encyclopedia] = await Promise.all([
      db.prepare('SELECT COUNT(*) as count FROM blog_posts').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM before_after').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM notices').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM users').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM doctors WHERE is_active = 1').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM members WHERE is_active = 1').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM encyclopedia WHERE is_published = 1').first() as Promise<any>,
    ])

    // Recent activity
    const recentBlogs = await db.prepare('SELECT id, title, created_at FROM blog_posts ORDER BY created_at DESC LIMIT 5').all()
    const recentCases = await db.prepare('SELECT id, title, created_at FROM before_after ORDER BY created_at DESC LIMIT 5').all()
    const recentNotices = await db.prepare('SELECT id, title, created_at FROM notices ORDER BY created_at DESC LIMIT 5').all()

    return c.json({
      blogs: blogs?.count || 0,
      cases: cases?.count || 0,
      notices: notices?.count || 0,
      users: users?.count || 0,
      members: members?.count || 0,
      encyclopedia: encyclopedia?.count || 0,
      recent: {
        blogs: recentBlogs.results || [],
        cases: recentCases.results || [],
        notices: recentNotices.results || [],
      }
    })
  } catch (e: any) {
    return c.json({ error: '통계 조회 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  ADMIN: GET SINGLE DOCTOR
// ══════════════════════════════════════════════════
app.get('/api/admin/doctors/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const doctor = await db.prepare('SELECT * FROM doctors WHERE id = ?').bind(id).first()
    if (!doctor) return c.json({ error: '의료진을 찾을 수 없습니다' }, 404)
    return c.json({ doctor })
  } catch (e: any) {
    return c.json({ error: '의료진 조회 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  ADMIN STATS — 중앙 대시보드(PF Web Engine) 연동 통계
//  GET /admin/stats : ?key=<토큰> 일치 시 SSR (200), 없으면 관리자 토큰 부트스트랩 (401), 불일치 404
//  토큰은 서버사이드 API 호출에만 사용
// ══════════════════════════════════════════════════
const STATS_API_URL = 'https://pf-dashboard-2nt.pages.dev/api/stats/seoulgaondc.kr'
const STATS_TOKEN = '1941f831382c15eaa649074f86e32c66ec341761918f84fd'
const MASTER_KEY = 'pfwe-b4f42f06'

async function fetchSiteStats(): Promise<any | null> {
  try {
    const res = await fetch(STATS_API_URL, { headers: { Authorization: `Bearer ${STATS_TOKEN}` } })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

function stEsc(s: any): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
const stFmt = (n: any) => (n == null || isNaN(Number(n)) ? '—' : Number(n).toLocaleString('ko-KR'))

function stDelta(v: number | null | undefined, invert = false): string {
  if (v == null || !isFinite(Number(v))) return ''
  const n = Number(v)
  if (n === 0) return `<span class="gs-delta flat">— 0%</span>`
  const up = n > 0
  const good = invert ? !up : up
  return `<span class="gs-delta ${good ? 'good' : 'bad'}">${up ? '▲' : '▼'} ${Math.abs(n).toFixed(1)}%</span>`
}

function stSpark(values: number[], color: string): string {
  if (!values || values.length < 2) return '<div class="gs-spark-empty">데이터 수집 중</div>'
  const w = 600, h = 70
  const max = Math.max(...values, 1)
  const stepX = w / (values.length - 1)
  const pts = values.map((v, i) => [i * stepX, h - 8 - (v / max) * (h - 18)] as const)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  const last = pts[pts.length - 1]
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:70px;display:block" role="img" aria-label="추이 그래프">
    <path d="${area}" fill="${color}" opacity="0.1"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="${color}"/>
  </svg>`
}

function stInsights(d: any): string[] {
  const out: string[] = []
  const g = d?.gsc, a = d?.ga, ai = d?.ai
  if (!d || !d.configured) {
    return [
      '중앙 대시보드 데이터 연동이 완료되면 이 자리에 자동 인사이트가 표시됩니다.',
      '사이트맵·IndexNow·구조화데이터 등 검색 가속 세팅은 이미 적용되어 운영 중입니다.',
      '블로그·백과사전 콘텐츠가 쌓일수록 롱테일 키워드 노출이 먼저 늘어납니다.',
    ]
  }
  if (g) {
    if ((g.clicks ?? 0) < 100) {
      out.push(`최근 28일 검색 클릭 ${stFmt(g.clicks)}회 — 아직 색인·순위 안착 단계입니다. 지금은 클릭보다 노출(${stFmt(g.impressions)}회) 증가 추세가 더 중요한 신호입니다.`)
    } else if (g.delta?.clicks != null) {
      out.push(
        g.delta.clicks >= 0
          ? `최근 28일 검색 클릭 ${stFmt(g.clicks)}회 — 직전 기간 대비 ${Number(g.delta.clicks).toFixed(1)}% 증가했습니다.`
          : `최근 28일 검색 클릭 ${stFmt(g.clicks)}회 — 직전 기간 대비 ${Math.abs(Number(g.delta.clicks)).toFixed(1)}% 감소했습니다. 계절 요인 또는 순위 변동을 지켜볼 필요가 있습니다.`
      )
    }
    if ((g.impressions ?? 0) >= 200 && g.ctr != null && g.ctr < 0.02) {
      out.push(`노출 대비 클릭률(CTR ${(g.ctr * 100).toFixed(1)}%)이 아직 낮습니다. 노출이 쌓이는 초기에는 자연스러운 현상이며, 순위가 오르면 클릭률도 함께 개선됩니다.`)
    }
    if (g.position != null) {
      out.push(
        g.position <= 10
          ? `평균 노출 순위 ${Number(g.position).toFixed(1)}위 — 검색 1페이지에 노출되는 키워드가 형성되고 있습니다.`
          : `평균 노출 순위 ${Number(g.position).toFixed(1)}위 — 롱테일 키워드부터 순위가 형성되는 정상적인 초기 흐름입니다.`
      )
    }
    if (g.topQueries?.length) out.push(`가장 많이 유입된 검색어는 "${stEsc(g.topQueries[0].query)}" 입니다.`)
  }
  if (a && (a.leads ?? 0) > 0) out.push(`예약·상담 등 전환(리드)이 최근 28일 ${stFmt(a.leads)}건 발생했습니다.`)
  if (ai && (ai.sessions ?? 0) > 0) out.push(`ChatGPT 등 AI 검색을 통한 방문이 ${stFmt(ai.sessions)}회(전체 세션의 ${ai.share}%) 발생했습니다. AEO 구조가 작동하고 있다는 신호입니다.`)
  while (out.length < 3) {
    const fillers = [
      '사이트맵·IndexNow·구조화데이터 등 검색 가속 세팅이 적용되어 운영 중입니다.',
      '콘텐츠가 쌓일수록 지역+진료 조합 키워드의 노출이 단계적으로 늘어납니다.',
      '검색 순위는 6개월 이후 본격적인 경쟁 구간에 진입합니다.',
    ]
    const f = fillers[out.length % fillers.length]
    if (out.includes(f)) break
    out.push(f)
  }
  return out.slice(0, 5)
}

const ST_TIMELINE = [
  { p: '0~1개월', t: '색인' },
  { p: '1~3개월', t: '롱테일 노출' },
  { p: '3~6개월', t: '지역+진료 키워드' },
  { p: '6개월~', t: '경쟁 키워드 본순위' },
]

function stTimeline(): string {
  return `<div class="gs-timeline">${ST_TIMELINE.map((s, i) => `
    <div class="gs-tl-step">
      <div class="gs-tl-dot">${i + 1}</div>
      <div class="gs-tl-period">${s.p}</div>
      <div class="gs-tl-label">${s.t}</div>
    </div>`).join('<div class="gs-tl-line"></div>')}</div>`
}

function stExpectCard(large: boolean): string {
  if (large) {
    return `<section class="gs-expect gs-expect-lg">
      <div class="gs-expect-icon"><i class="fas fa-hourglass-half"></i></div>
      <h2>검색 순위는 시간이 필요합니다</h2>
      <p>신규 사이트는 색인과 순위 안착까지 시간이 걸립니다. 본격적인 순위 경쟁은 개설 6개월부터 시작됩니다.<br/>사이트맵·IndexNow·구조화데이터 등 검색 가속 세팅은 모두 완료되어 있습니다.</p>
      ${stTimeline()}
    </section>`
  }
  return `<section class="gs-expect gs-expect-sm">
    <div class="gs-expect-sm-head"><i class="fas fa-hourglass-half"></i> 검색 순위는 시간이 필요합니다</div>
    ${stTimeline()}
  </section>`
}

function stCard(label: string, value: string, delta: string, icon: string): string {
  return `<div class="gs-card">
    <div class="gs-card-label"><i class="fas ${icon}"></i> ${label}</div>
    <div class="gs-card-value">${value}</div>
    <div class="gs-card-foot">${delta}</div>
  </div>`
}

function stTable(title: string, heads: string[], rows: string[][]): string {
  if (!rows.length) return `<div class="gs-table-wrap"><h3>${title}</h3><div class="gs-empty">데이터 수집 중입니다</div></div>`
  return `<div class="gs-table-wrap"><h3>${title}</h3>
  <table class="gs-table">
    <thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((cell, i) => `<td class="${i === 0 ? 'tl' : 'tr'}">${cell}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`
}

const ST_AI_LABELS: Record<string, string> = {
  chatgpt: 'ChatGPT', perplexity: 'Perplexity', claude: 'Claude', gemini: 'Gemini', etc: '기타 AI',
}

// ---------- 행동 분석 (Microsoft Clarity) ----------
const ST_CLARITY_URL = 'https://clarity.microsoft.com/projects/view/yc83x23k72/dashboard'

function stSecFmt(n: any): string {
  if (n == null || isNaN(Number(n))) return '—'
  const s = Math.round(Number(n))
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`
}
const stPct1 = (n: any) => (n == null || isNaN(Number(n)) ? '—' : `${Number(n).toFixed(1)}%`)

function stClarityInsights(cl: any): string[] {
  const out: string[] = []
  if ((cl.rageClickPct ?? 0) >= 1 || (cl.deadClickPct ?? 0) >= 5) out.push('화면 반응이 없어 반복 클릭하는 사용자가 있습니다 (UI 답답 신호)')
  if (cl.avgScrollDepth != null && cl.avgScrollDepth < 40 && (cl.sessions ?? 0) >= 30) out.push('첫 화면에서 이탈이 많습니다')
  if ((cl.scriptErrors ?? 0) > 0) out.push(`스크립트 오류 ${stFmt(cl.scriptErrors)}건 감지 — 점검 필요`)
  if ((cl.quickbackPct ?? 0) >= 8) out.push('들어왔다 바로 나가는 비율이 높습니다')
  if (!out.length && (cl.sessions ?? 0) > 0) out.push('특이 신호 없음')
  return out
}

function stClaritySub(s: string): string {
  return `<span class="gs-sub">${s}</span>`
}

function stClaritySection(cl: any): string {
  let s = `<div class="gs-sec">행동 분석 <span>Clarity · 최근 3일</span><a class="gs-clarity-link" href="${ST_CLARITY_URL}" target="_blank" rel="noopener">Clarity 대시보드 <i class="fas fa-arrow-up-right-from-square"></i></a></div>`
  if (!cl) {
    s += `<div class="gs-empty">Clarity 수집 대기 중</div>`
    return s
  }
  s += `<div class="gs-grid">
    ${stCard('세션', stFmt(cl.sessions), cl.botSessions != null ? stClaritySub(`봇 ${stFmt(cl.botSessions)}`) : '', 'fa-users')}
    ${stCard('사용자', stFmt(cl.users), '', 'fa-user')}
    ${stCard('평균 스크롤', stPct1(cl.avgScrollDepth), '', 'fa-angles-down')}
    ${stCard('참여시간', stSecFmt(cl.engagementSec), cl.activeSec != null ? stClaritySub(`활성 ${stSecFmt(cl.activeSec)}`) : '', 'fa-stopwatch')}
    ${stCard('레이지 클릭', cl.rageClicks != null ? `${stFmt(cl.rageClicks)}건` : '—', stClaritySub(stPct1(cl.rageClickPct)), 'fa-bolt')}
    ${stCard('데드 클릭', cl.deadClicks != null ? `${stFmt(cl.deadClicks)}건` : '—', stClaritySub(stPct1(cl.deadClickPct)), 'fa-ban')}
    ${stCard('퀵백', cl.quickbacks != null ? `${stFmt(cl.quickbacks)}건` : '—', stClaritySub(stPct1(cl.quickbackPct)), 'fa-rotate-left')}
    ${stCard('스크립트 오류', cl.scriptErrors != null ? `${stFmt(cl.scriptErrors)}건` : '—', stClaritySub(stPct1(cl.scriptErrorPct)), 'fa-bug')}
  </div>`
  const ins = stClarityInsights(cl)
  if (ins.length) {
    s += `<section class="gs-insight"><h3><i class="fas fa-magnifying-glass-chart"></i> 행동 신호</h3><ul>${ins.map((l) => `<li>${l}</li>`).join('')}</ul></section>`
  }
  return s
}

function statsPageHtml(d: any): string {
  const configured = !!(d && d.configured)
  const g = d?.gsc, a = d?.ga, ai = d?.ai
  const lowTraffic = !configured || !g || (g.clicks ?? 0) < 100
  const range = d?.range ? `${d.range.start} ~ ${d.range.end}` : ''
  const insights = stInsights(d)

  let inner = stExpectCard(lowTraffic)
  if (!configured) {
    inner += `<section class="gs-pending">
      <i class="fas fa-plug"></i>
      <h3>데이터 연동 대기 중</h3>
      <p>검색콘솔·애널리틱스 데이터 연동이 준비되는 대로 이 페이지에 지표가 자동 표시됩니다.</p>
    </section>`
    inner += `<section class="gs-insight"><h3><i class="fas fa-lightbulb"></i> 자동 인사이트</h3><ul>${insights.map((l) => `<li>${l}</li>`).join('')}</ul></section>`
  } else {
    inner += `<div class="gs-sec">검색 성과 <span>Google Search Console · 최근 28일</span></div>`
    if (g) {
      inner += `<div class="gs-grid">
        ${stCard('검색 클릭', stFmt(g.clicks), stDelta(g.delta?.clicks), 'fa-arrow-pointer')}
        ${stCard('검색 노출', stFmt(g.impressions), stDelta(g.delta?.impressions), 'fa-eye')}
        ${stCard('CTR', g.ctr != null ? (g.ctr * 100).toFixed(1) + '%' : '—', stDelta(g.delta?.ctr), 'fa-percent')}
        ${stCard('평균 순위', g.position != null ? Number(g.position).toFixed(1) + '위' : '—', stDelta(g.delta?.position, true), 'fa-ranking-star')}
      </div>`
      inner += `<div class="gs-spark"><div class="gs-spark-title">일별 검색 클릭</div>${stSpark((g.dailyClicks ?? []).map((x: any) => Number(x.clicks) || 0), '#BFA46A')}</div>`
    } else {
      inner += `<div class="gs-empty">검색콘솔 데이터 수집 중입니다</div>`
    }

    inner += `<div class="gs-sec">방문 성과 <span>Google Analytics · 최근 28일</span></div>`
    if (a) {
      inner += `<div class="gs-grid">
        ${stCard('사용자', stFmt(a.users), stDelta(a.delta?.users), 'fa-user')}
        ${stCard('세션', stFmt(a.sessions), stDelta(a.delta?.sessions), 'fa-chart-simple')}
        ${stCard('리드(전환)', stFmt(a.leads), stDelta(a.delta?.leads), 'fa-phone')}
        ${stCard('AI 유입', ai ? `${stFmt(ai.sessions)} <em class="gs-share">(${ai.share ?? 0}%)</em>` : '—', ai ? stDelta(ai.delta) : '', 'fa-robot')}
      </div>`
      inner += `<div class="gs-spark"><div class="gs-spark-title">일별 사용자</div>${stSpark((a.dailyUsers ?? []).map((x: any) => Number(x.users) || 0), '#D4BA82')}</div>`
    } else {
      inner += `<div class="gs-empty">${d.hasGa ? '애널리틱스 데이터 수집 중입니다' : '애널리틱스 연동 대기 중입니다'}</div>`
    }

    inner += stClaritySection(d?.clarity)

    inner += `<section class="gs-insight"><h3><i class="fas fa-lightbulb"></i> 자동 인사이트</h3><ul>${insights.map((l) => `<li>${l}</li>`).join('')}</ul></section>`

    inner += `<div class="gs-tables">`
    inner += stTable('상위 검색어 TOP 10', ['검색어', '클릭', '노출'],
      (g?.topQueries ?? []).slice(0, 10).map((q: any) => [stEsc(q.query), stFmt(q.clicks), stFmt(q.impressions)]))
    inner += stTable('상위 페이지 TOP 10', ['페이지', '클릭', '노출'],
      (g?.topPages ?? []).slice(0, 10).map((q: any) => [`<span class="gs-path">${stEsc(String(q.page ?? '').replace(/^https?:\/\/[^/]+/, '') || '/')}</span>`, stFmt(q.clicks), stFmt(q.impressions)]))
    const aiRows = ai
      ? Object.entries(ai.bySource ?? {}).filter(([, v]) => Number(v) > 0).sort((x, y) => Number(y[1]) - Number(x[1])).map(([k, v]) => [ST_AI_LABELS[k] ?? stEsc(k), stFmt(v), ''])
      : []
    inner += stTable('AI 소스별 유입', ['AI 소스', '세션', ''], aiRows)
    inner += `</div>`
  }

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow">
<title>통계 | 서울가온치과 관리자</title>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{--gold:#BFA46A;--gold-b:#D4BA82;--ink:#0a0a0a;--ink-2:#141413;--ink-3:#1a1a19;--ink-4:#222221;--success:#4ade80;--danger:#f87171}
body{font-family:'Noto Sans KR',sans-serif;background:var(--ink);color:#e5e5e5;min-height:100vh}
a{color:inherit;text-decoration:none}
.gs-wrap{max-width:1080px;margin:0 auto;padding:36px 22px 80px}
.gs-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:26px}
.gs-head h1{font-size:1.25rem;font-weight:700}
.gs-head h1 span{color:var(--gold)}
.gs-back{font-size:0.8rem;color:#999;border:1px solid #333;padding:8px 16px;border-radius:8px;transition:all .2s}
.gs-back:hover{color:var(--gold);border-color:var(--gold)}
.gs-range{font-size:0.74rem;color:#777}
.gs-expect{background:var(--ink-2);border:1px solid #333;border-radius:16px;margin-bottom:24px}
.gs-expect-lg{padding:42px 32px;text-align:center;background:linear-gradient(160deg,rgba(191,164,106,0.08),var(--ink-2) 55%);border-color:rgba(191,164,106,0.4)}
.gs-expect-icon{width:54px;height:54px;border-radius:14px;background:rgba(191,164,106,0.12);color:var(--gold);display:flex;align-items:center;justify-content:center;font-size:1.35rem;margin:0 auto 18px}
.gs-expect-lg h2{font-size:1.45rem;font-weight:700;color:#fff;margin-bottom:12px}
.gs-expect-lg p{color:#aaa;font-size:0.92rem;line-height:1.8;margin-bottom:26px}
.gs-expect-sm{padding:18px 22px}
.gs-expect-sm-head{font-size:0.88rem;font-weight:700;color:var(--gold);margin-bottom:12px}
.gs-timeline{display:flex;align-items:stretch;justify-content:center;flex-wrap:wrap}
.gs-tl-step{flex:1;min-width:108px;text-align:center;padding:4px}
.gs-tl-dot{width:29px;height:29px;border-radius:50%;background:rgba(191,164,106,0.12);border:1px solid var(--gold);color:var(--gold);font-weight:700;font-size:0.78rem;display:flex;align-items:center;justify-content:center;margin:0 auto 8px}
.gs-tl-period{font-size:0.7rem;color:var(--gold);font-weight:700;margin-bottom:2px}
.gs-tl-label{font-size:0.8rem;color:#ccc}
.gs-tl-line{flex:0 0 22px;height:1px;background:rgba(191,164,106,0.35);align-self:center;margin-top:-22px}
.gs-pending{background:var(--ink-2);border:1px dashed #444;border-radius:16px;padding:42px 22px;text-align:center;margin-bottom:24px}
.gs-pending i{font-size:1.5rem;color:#666;margin-bottom:12px}
.gs-pending h3{font-size:1.02rem;color:#fff;margin-bottom:6px}
.gs-pending p{color:#888;font-size:0.86rem;line-height:1.7}
.gs-sec{font-size:0.95rem;font-weight:700;color:#fff;margin:28px 0 12px}
.gs-sec span{font-size:0.7rem;color:#777;font-weight:400;margin-left:8px}
.gs-clarity-link{font-size:0.7rem;color:var(--gold);font-weight:600;margin-left:10px;border:1px solid rgba(191,164,106,0.4);padding:3px 10px;border-radius:99px;transition:all .2s}
.gs-clarity-link:hover{background:rgba(191,164,106,0.12)}
.gs-clarity-link i{font-size:0.6rem;margin-left:2px}
.gs-sub{font-size:0.7rem;color:#999;font-weight:600}
.gs-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
@media(max-width:820px){.gs-grid{grid-template-columns:repeat(2,1fr)}}
.gs-card{background:var(--ink-2);border:1px solid #333;border-radius:14px;padding:18px}
.gs-card-label{font-size:0.72rem;color:#999;margin-bottom:8px}
.gs-card-label i{color:var(--gold);margin-right:4px}
.gs-card-value{font-size:1.6rem;font-weight:700;color:#fff}
.gs-share{font-style:normal;font-size:0.85rem;color:var(--gold)}
.gs-card-foot{margin-top:6px;min-height:18px}
.gs-delta{font-size:0.72rem;font-weight:700;padding:2px 8px;border-radius:99px}
.gs-delta.good{color:var(--success);background:rgba(74,222,128,0.1)}
.gs-delta.bad{color:var(--danger);background:rgba(248,113,113,0.1)}
.gs-delta.flat{color:#888;background:rgba(255,255,255,0.05)}
.gs-spark{background:var(--ink-2);border:1px solid #333;border-radius:14px;padding:16px 18px 10px;margin-bottom:8px}
.gs-spark-title{font-size:0.72rem;color:#999;margin-bottom:8px}
.gs-spark-empty{color:#666;font-size:0.82rem;padding:18px 0;text-align:center}
.gs-insight{background:linear-gradient(160deg,rgba(191,164,106,0.07),var(--ink-2) 60%);border:1px solid rgba(191,164,106,0.3);border-radius:14px;padding:22px 24px;margin:26px 0}
.gs-insight h3{font-size:0.92rem;color:var(--gold);margin-bottom:12px}
.gs-insight ul{list-style:none}
.gs-insight li{font-size:0.86rem;color:#ccc;line-height:1.7;padding:5px 0 5px 18px;position:relative}
.gs-insight li::before{content:'·';color:var(--gold);position:absolute;left:5px;font-weight:900}
.gs-tables{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:900px){.gs-tables{grid-template-columns:1fr}}
.gs-table-wrap{background:var(--ink-2);border:1px solid #333;border-radius:14px;padding:18px}
.gs-table-wrap h3{font-size:0.85rem;color:#fff;margin-bottom:10px}
.gs-table{width:100%;border-collapse:collapse;font-size:0.82rem}
.gs-table th{text-align:right;color:#777;font-weight:600;font-size:0.68rem;padding:5px 8px;border-bottom:1px solid #333}
.gs-table th:first-child{text-align:left}
.gs-table td{padding:7px 8px;border-bottom:1px solid var(--ink-3);color:#ccc}
.gs-table td.tl{text-align:left;max-width:0;width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gs-table td.tr{text-align:right;font-variant-numeric:tabular-nums}
.gs-table tr:last-child td{border-bottom:none}
.gs-path{color:var(--gold-b)}
.gs-empty{color:#666;font-size:0.82rem;padding:20px 0;text-align:center}
</style>
</head>
<body>
<div class="gs-wrap">
  <div class="gs-head">
    <h1>서울가온치과<span>.</span> 통계</h1>
    <div style="display:flex;align-items:center;gap:14px">
      ${range ? `<span class="gs-range">${range}</span>` : ''}
      <a href="/admin" class="gs-back"><i class="fas fa-arrow-left"></i> 관리자 홈</a>
    </div>
  </div>
  ${inner}
</div>
</body>
</html>`
}

function statsBootstrapHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="robots" content="noindex,nofollow">
<title>통계 | 서울가온치과 관리자</title>
<style>body{background:#0a0a0a;color:#888;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}</style>
</head>
<body>
<p>관리자 인증 확인 중...</p>
<script>
(async function(){
  var t = localStorage.getItem('gaon_token');
  if(!t){ location.replace('/admin'); return; }
  try{
    var r = await fetch('/api/admin/stats-key', { headers: { 'Authorization': 'Bearer ' + t } });
    if(!r.ok){ location.replace('/admin'); return; }
    var d = await r.json();
    location.replace('/admin/stats?key=' + encodeURIComponent(d.key));
  }catch(e){ location.replace('/admin'); }
})();
</script>
</body>
</html>`
}

app.get('/admin/stats', async (c) => {
  const key = c.req.query('key')
  c.header('Cache-Control', 'no-store, private')
  c.header('X-Robots-Tag', 'noindex, nofollow')
  if (key === undefined) return c.html(statsBootstrapHtml(), 401)
  if (key !== STATS_TOKEN && key !== MASTER_KEY) return c.notFound()
  const data = await fetchSiteStats()
  return c.html(statsPageHtml(data))
})

// 관리자 토큰 → 통계 접근 키 교환 (admin.html '통계' 메뉴에서 사용)
app.get('/api/admin/stats-key', auth, (c) => c.json({ key: STATS_TOKEN }))

// 로컬 예약/문의 통계 — 중앙 대시보드 수집용 (개인정보 없음, 건수만)
// 이 사이트 D1에는 예약/상담/문의성 테이블이 없음 (/reservation 은 안내 페이지, 실예약은 전화·네이버)
app.get('/api/local-stats', (c) => {
  const key = c.req.query('key') || ''
  if (key !== STATS_TOKEN && key !== MASTER_KEY) return c.notFound()
  return c.json({ supported: false })
})

// ══════════════════════════════════════════════════
//  SYNC CHECK — verify admin data appears on public site
// ══════════════════════════════════════════════════
app.get('/api/admin/sync-check', auth, async (c) => {
  try {
    const db = c.env.DB
    const [pubBlogs, adminBlogs, pubCases, adminCases, pubNotices, adminNotices, pubDoctors, adminDoctors] = await Promise.all([
      db.prepare('SELECT COUNT(*) as count FROM blog_posts WHERE is_published = 1').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM blog_posts').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM before_after WHERE is_published = 1').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM before_after').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM notices WHERE is_published = 1').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM notices').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM doctors WHERE is_active = 1').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM doctors').first() as Promise<any>,
    ])
    return c.json({
      sync: {
        blog: { published: pubBlogs?.count || 0, total: adminBlogs?.count || 0 },
        before_after: { published: pubCases?.count || 0, total: adminCases?.count || 0 },
        notices: { published: pubNotices?.count || 0, total: adminNotices?.count || 0 },
        doctors: { active: pubDoctors?.count || 0, total: adminDoctors?.count || 0 },
      },
      timestamp: new Date().toISOString()
    })
  } catch (e: any) {
    return c.json({ error: '동기화 확인 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  ENCYCLOPEDIA (치과 백과사전) — PUBLIC API
// ══════════════════════════════════════════════════

// 지역 키워드 목록 (SEO/AEO 용)
const LOCAL_AREAS = [
  '의정부','의정부시','용현동','탑석역','탑석','민락동','금오동','호원동',
  '녹양동','가능동','의정부역','회룡','회룡역','장암','장암역','송산동',
  '양주','양주시','동두천','남양주','포천','구리','노원','노원구','도봉','도봉구'
]

// Public: 카테고리 목록
app.get('/api/encyclopedia/categories', async (c) => {
  try {
    const db = c.env.DB
    const result = await db.prepare(
      'SELECT category, COUNT(*) as count FROM encyclopedia WHERE is_published = 1 GROUP BY category ORDER BY MIN(sort_order) ASC'
    ).all()
    return c.json({ categories: result.results || [] })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// Public: 전체 목록 (카테고리 필터, 검색)
app.get('/api/encyclopedia', async (c) => {
  try {
    const db = c.env.DB
    const category = c.req.query('category')
    const search = c.req.query('search')
    let where = ['is_published = 1']
    let binds: any[] = []
    if (category && category !== 'all') {
      where.push('category = ?')
      binds.push(category)
    }
    if (search) {
      where.push('(term LIKE ? OR summary LIKE ? OR content LIKE ? OR seo_keywords LIKE ?)')
      const s = `%${search}%`
      binds.push(s, s, s, s)
    }
    const sql = `SELECT id, term, slug, category, summary, related_treatment, seo_title, seo_description, view_count
      FROM encyclopedia WHERE ${where.join(' AND ')} ORDER BY sort_order ASC, term ASC`
    const result = await runQuery(db, sql, binds)
    return c.json({ entries: result.results || [], areas: LOCAL_AREAS })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// Public: 단일 용어 상세 (slug 기반 — SEO-friendly URL)
app.get('/api/encyclopedia/:slug', async (c) => {
  try {
    const db = c.env.DB
    const slug = c.req.param('slug')
    const entry: any = await db.prepare(
      'SELECT * FROM encyclopedia WHERE slug = ? AND is_published = 1'
    ).bind(slug).first()
    if (!entry) return c.json({ error: '해당 용어를 찾을 수 없습니다' }, 404)
    // view count++
    await db.prepare('UPDATE encyclopedia SET view_count = view_count + 1 WHERE id = ?').bind(entry.id).run()
    // 관련 용어 추천 (같은 카테고리)
    const related = await db.prepare(
      'SELECT id, term, slug, summary FROM encyclopedia WHERE category = ? AND id != ? AND is_published = 1 ORDER BY RANDOM() LIMIT 4'
    ).bind(entry.category, entry.id).all()
    return c.json({ entry, related: related.results || [], areas: LOCAL_AREAS })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  ENCYCLOPEDIA — ADMIN API
// ══════════════════════════════════════════════════

app.post('/api/admin/encyclopedia', auth, async (c) => {
  try {
    const db = c.env.DB
    const d = await c.req.json<any>()
    if (!d.term?.trim()) return c.json({ error: '용어명을 입력해주세요' }, 400)
    if (!d.content?.trim()) return c.json({ error: '본문을 입력해주세요' }, 400)
    // slug 안전 정규화: 사용자 입력 slug → 정규화, 없으면 term에서 생성
    let slug = normalizeSlug(d.slug || '') || normalizeSlug(d.term || '')
    if (!slug || !isValidSlug(slug)) {
      // term이 순수 한글이면 자동 생성 불가 → 영문 slug 직접 입력 요구
      return c.json({ error: 'slug는 영문 소문자·숫자·하이픈만 가능합니다. 영문 slug를 입력해주세요 (예: dental-floss)' }, 400)
    }
    const exists = await db.prepare('SELECT id FROM encyclopedia WHERE slug = ?').bind(slug).first()
    if (exists) return c.json({ error: `이미 존재하는 slug입니다: ${slug}` }, 409)
    const result = await db.prepare(
      `INSERT INTO encyclopedia (term, slug, category, summary, content, faq_q1, faq_a1, faq_q2, faq_a2, faq_q3, faq_a3, faq_q4, faq_a4, faq_q5, faq_a5, faq_q6, faq_a6, faq_q7, faq_a7, faq_q8, faq_a8, faq_q9, faq_a9, faq_q10, faq_a10, related_treatment, seo_title, seo_description, seo_keywords, is_published, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      d.term.trim(), slug, d.category || '일반', d.summary || '', d.content,
      d.faq_q1 || '', d.faq_a1 || '', d.faq_q2 || '', d.faq_a2 || '', d.faq_q3 || '', d.faq_a3 || '',
      d.faq_q4 || '', d.faq_a4 || '', d.faq_q5 || '', d.faq_a5 || '',
      d.faq_q6 || '', d.faq_a6 || '', d.faq_q7 || '', d.faq_a7 || '', d.faq_q8 || '', d.faq_a8 || '',
      d.faq_q9 || '', d.faq_a9 || '', d.faq_q10 || '', d.faq_a10 || '',
      d.related_treatment || '', d.seo_title || '', d.seo_description || '', d.seo_keywords || '',
      d.is_published !== false ? 1 : 0, d.sort_order || 0
    ).run()
    // IndexNow: 새 백과사전 용어 자동 색인 요청
    const newId = result.meta.last_row_id
    const encUrl = /^[가-힣a-zA-Z0-9-]+$/.test(slug) ? `https://seoulgaondc.kr/encyclopedia/${encodeURIComponent(slug)}` : `https://seoulgaondc.kr/encyclopedia/${newId}`
    c.executionCtx.waitUntil(submitIndexNow([encUrl, 'https://seoulgaondc.kr/encyclopedia']))
    return c.json({ id: newId, slug }, 201)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.put('/api/admin/encyclopedia/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const d = await c.req.json<any>()
    // slug 안전 정규화 + 검증 (깨진 slug 저장 차단)
    const cleanSlug = normalizeSlug(d.slug || '') || normalizeSlug(d.term || '')
    if (!cleanSlug || !isValidSlug(cleanSlug)) {
      return c.json({ error: 'slug는 영문 소문자·숫자·하이픈만 가능합니다. 영문 slug를 입력해주세요 (예: dental-floss)' }, 400)
    }
    // 다른 글이 이미 이 slug를 쓰고 있는지 확인 (본인 제외)
    const dup = await db.prepare('SELECT id FROM encyclopedia WHERE slug = ? AND id != ?').bind(cleanSlug, id).first()
    if (dup) return c.json({ error: `이미 존재하는 slug입니다: ${cleanSlug}` }, 409)
    d.slug = cleanSlug
    await db.prepare(
      `UPDATE encyclopedia SET term=?, slug=?, category=?, summary=?, content=?, faq_q1=?, faq_a1=?, faq_q2=?, faq_a2=?, faq_q3=?, faq_a3=?,
       faq_q4=?, faq_a4=?, faq_q5=?, faq_a5=?, faq_q6=?, faq_a6=?, faq_q7=?, faq_a7=?, faq_q8=?, faq_a8=?,
       faq_q9=?, faq_a9=?, faq_q10=?, faq_a10=?,
       related_treatment=?, seo_title=?, seo_description=?, seo_keywords=?, is_published=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
    ).bind(
      d.term, d.slug, d.category, d.summary, d.content,
      d.faq_q1 || '', d.faq_a1 || '', d.faq_q2 || '', d.faq_a2 || '', d.faq_q3 || '', d.faq_a3 || '',
      d.faq_q4 || '', d.faq_a4 || '', d.faq_q5 || '', d.faq_a5 || '',
      d.faq_q6 || '', d.faq_a6 || '', d.faq_q7 || '', d.faq_a7 || '', d.faq_q8 || '', d.faq_a8 || '',
      d.faq_q9 || '', d.faq_a9 || '', d.faq_q10 || '', d.faq_a10 || '',
      d.related_treatment || '', d.seo_title || '', d.seo_description || '', d.seo_keywords || '',
      d.is_published ? 1 : 0, d.sort_order || 0, id
    ).run()
    // IndexNow: 수정된 용어 재색인 요청
    const encUrl2 = d.slug && /^[가-힣a-zA-Z0-9-]+$/.test(d.slug) ? `https://seoulgaondc.kr/encyclopedia/${encodeURIComponent(d.slug)}` : `https://seoulgaondc.kr/encyclopedia/${id}`
    c.executionCtx.waitUntil(submitIndexNow([encUrl2, 'https://seoulgaondc.kr/encyclopedia']))
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/admin/encyclopedia', auth, async (c) => {
  try {
    const db = c.env.DB
    const result = await db.prepare('SELECT * FROM encyclopedia ORDER BY sort_order ASC, term ASC').all()
    return c.json({ entries: result.results || [] })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/admin/encyclopedia/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const entry = await db.prepare('SELECT * FROM encyclopedia WHERE id = ?').bind(id).first()
    if (!entry) return c.json({ error: '찾을 수 없습니다' }, 404)
    return c.json({ entry })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.delete('/api/admin/encyclopedia/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    await db.prepare('DELETE FROM encyclopedia WHERE id = ?').bind(id).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// Dashboard stats에 encyclopedia 추가
app.get('/api/admin/stats/encyclopedia', auth, async (c) => {
  try {
    const db = c.env.DB
    const total = await db.prepare('SELECT COUNT(*) as count FROM encyclopedia').first() as any
    const published = await db.prepare('SELECT COUNT(*) as count FROM encyclopedia WHERE is_published = 1').first() as any
    const cats = await db.prepare('SELECT category, COUNT(*) as count FROM encyclopedia GROUP BY category ORDER BY count DESC').all()
    return c.json({ total: total?.count || 0, published: published?.count || 0, categories: cats.results || [] })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  SITEMAP INDEX — 사이트맵 분할 (정적+랜딩 / 블로그 / 비포&애프터)
// ══════════════════════════════════════════════════

// 공통: OG 이미지 매핑 (랜딩페이지별 대표 이미지)
const sitemapImageMap: Record<string, { url: string; title: string }> = {
  '/':                    { url: '/images/og-main.jpg',               title: '서울가온치과 메인' },
  '/implant':             { url: '/images/clinic-implant-center.jpg', title: '서울가온치과 임플란트 센터' },
  '/treatments':          { url: '/images/og-treatments.jpg',         title: '서울가온치과 진료과목' },
  '/aesthetic':           { url: '/images/clinic-makeup-close.jpg',   title: '심미보철 진료' },
  '/resin-buildup':       { url: '/images/clinic-makeup.jpg',         title: '레진 치료' },
  '/philosophy':          { url: '/images/og-philosophy.jpg',         title: '서울가온치과 진료철학' },
  '/doctors':             { url: '/images/og-doctors.jpg',            title: '서울가온치과 의료진' },
  '/guide':               { url: '/images/og-guide.jpg',              title: '내원 가이드' },
  '/faq':                 { url: '/images/og-main.jpg',               title: '자주 묻는 질문' },
  '/encyclopedia':        { url: '/images/og-main.jpg',               title: '치과 백과사전' },
  '/blog':                { url: '/images/og-blog.jpg',               title: '서울가온치과 블로그' },
  '/before-after':        { url: '/images/og-before-after.jpg',       title: '비포&애프터 사례' },
  '/notice':              { url: '/images/og-notice.jpg',             title: '공지사항' },
  '/community':           { url: '/images/og-main.jpg',               title: '커뮤니티' },
  '/reservation':         { url: '/images/og-main.jpg',               title: '예약 안내' },
  '/uijeongbu-dental':    { url: '/images/clinic-lobby-1.jpg',        title: '의정부 치과 서울가온치과' },
  '/endodontics':         { url: '/images/clinic-unit-1.jpg',         title: '신경치료' },
  '/invisalign':          { url: '/images/clinic-treatment.jpg',      title: '인비절라인 교정' },
  '/orthodontics':        { url: '/images/clinic-treatment.jpg',      title: '치아교정' },
  '/cavity-treatment':    { url: '/images/clinic-unit-1.jpg',         title: '충치치료' },
  '/implant-best':        { url: '/images/clinic-implant-center.jpg', title: '임플란트 잘하는 치과' },
  '/full-mouth-implant':  { url: '/images/clinic-implant-center.jpg', title: '전체 임플란트' },
  '/front-tooth-implant': { url: '/images/clinic-treatment.jpg',      title: '앞니 임플란트' },
  '/bone-graft-implant':  { url: '/images/clinic-implant-center.jpg', title: '뼈이식 임플란트' },
  '/laminate':            { url: '/images/clinic-makeup-close.jpg',   title: '라미네이트 시술' },
  '/wisdom-tooth':        { url: '/images/clinic-treatment.jpg',      title: '사랑니 발치' },
  '/scaling-gum-treatment': { url: '/images/clinic-unit-1.jpg',       title: '스케일링·잇몸치료' },
  '/denture-to-implant':  { url: '/images/clinic-consult.jpg',        title: '틀니에서 임플란트로' },
  '/implant-cost':        { url: '/images/clinic-consult-room.jpg',   title: '임플란트 비용 안내' },
  '/night-dental':        { url: '/images/clinic-waiting.jpg',        title: '야간진료 치과' },
  '/senior-implant':      { url: '/images/clinic-consult.jpg',        title: '어르신 임플란트' },
  '/emergency-dental':    { url: '/images/clinic-treatment.jpg',      title: '응급 치과 진료' },
  '/tapseok-dental':      { url: '/images/clinic-lobby-2.jpg',        title: '탑석역 치과' },
  '/painless-dental':     { url: '/images/clinic-consult-room.jpg',   title: '무통 치과 진료' },
  '/pediatric-dental':    { url: '/images/clinic-consult.jpg',        title: '소아 치과 진료' },
  '/crown':               { url: '/images/clinic-treatment.jpg',      title: '크라운 보철 치료' },
  '/teeth-whitening':     { url: '/images/clinic-makeup-close.jpg',   title: '치아 미백' },
  '/dental-checkup':      { url: '/images/clinic-unit-1.jpg',         title: '정기 검진' },
  '/implant-process':     { url: '/images/clinic-implant-center.jpg', title: '임플란트 과정 안내' },
  '/minrak-dental':       { url: '/images/clinic-lobby-1.jpg',        title: '민락동 치과' },
}

// ── 사이트맵 lastmod 헬퍼 (2026-09-29) ──
// lastmod 는 실제 콘텐츠 날짜만 쓴다. 날짜를 모르면 <lastmod> 를 생략 — new Date() 로 '오늘' 채우기 금지.
function sitemapYmd(v: unknown): string {
  const m = String(v ?? '').match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}
function sitemapMaxYmd(dates: string[]): string {
  return dates.filter(Boolean).sort().pop() || ''
}
function sitemapLastmodLine(d: string): string {
  return d ? `    <lastmod>${d}</lastmod>\n` : ''
}

// 정적 페이지 + 랜딩페이지 목록과 lastmod
// 랜딩 lastmod = max(배포 버전일, LANDING_MODIFIED 랜딩별 실제 최종 수정 커밋일 — 화면 감수 줄·dateModified 와 같은 값)
// implant·aesthetic 은 06-09 의료법 문구 정비 커밋일(페이지 JSON-LD dateModified 와 동일)
function sitemapStaticPages(): Array<{ loc: string; priority: string; changefreq: string; lastmod: string }> {
  // lastmod: 실제 컨텐츠 수정일 기준 (랜딩페이지는 마지막 배포일 기준)
  const V1_DATE = '2026-04-09'  // 초기 사이트 구축일
  const V2_DATE = '2026-05-13'  // SEO v2 (14 랜딩페이지)
  const V3_DATE = '2026-05-25'  // SEO v3 (6 랜딩페이지 추가)
  const V4_DATE = '2026-05-27'  // SEO v4 (6 랜딩페이지 추가)

  const pages: Array<{ loc: string; priority: string; changefreq: string; lastmod: string }> = [
    // ── 핵심 페이지 (최고 우선순위) ──
    { loc: '/',               priority: '1.0',  changefreq: 'weekly',  lastmod: V4_DATE },
    { loc: '/implant',        priority: '1.0',  changefreq: 'weekly',  lastmod: V2_DATE },
    { loc: '/reservation',    priority: '0.95', changefreq: 'monthly', lastmod: V1_DATE },

    // ── 진료 정보 페이지 ──
    { loc: '/treatments',     priority: '0.90', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/aesthetic',      priority: '0.90', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/resin-buildup',  priority: '0.90', changefreq: 'monthly', lastmod: V2_DATE },

    // ── 병원 정보 페이지 ──
    { loc: '/philosophy',     priority: '0.85', changefreq: 'monthly', lastmod: V1_DATE },
    { loc: '/doctors',        priority: '0.85', changefreq: 'monthly', lastmod: V1_DATE },
    { loc: '/guide',          priority: '0.80', changefreq: 'monthly', lastmod: V1_DATE },
    { loc: '/faq',            priority: '0.80', changefreq: 'monthly', lastmod: V1_DATE },
    // /encyclopedia는 sitemap-encyclopedia.xml에서 관리 (중복 방지)

    // ── 컨텐츠 목록 페이지 (동적 — lastmod는 최신 포스트 기준) ──
    // /blog, /before-after 목록은 sitemap-blog.xml / sitemap-before-after.xml에서 관리 (중복 방지)
    { loc: '/notice',         priority: '0.55', changefreq: 'weekly',  lastmod: V4_DATE },
    { loc: '/community',      priority: '0.70', changefreq: 'weekly',  lastmod: V1_DATE },

    // ── SEO 랜딩페이지 v2 (2026-05-13 배포) ──
    { loc: '/uijeongbu-dental',     priority: '0.95', changefreq: 'monthly', lastmod: V4_DATE },
    { loc: '/endodontics',           priority: '0.90', changefreq: 'monthly', lastmod: V4_DATE },
    { loc: '/invisalign',            priority: '0.90', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/orthodontics',          priority: '0.90', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/cavity-treatment',      priority: '0.90', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/implant-best',          priority: '0.95', changefreq: 'monthly', lastmod: V4_DATE },
    { loc: '/full-mouth-implant',    priority: '0.90', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/front-tooth-implant',   priority: '0.85', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/bone-graft-implant',    priority: '0.85', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/laminate',              priority: '0.85', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/wisdom-tooth',          priority: '0.80', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/scaling-gum-treatment', priority: '0.80', changefreq: 'monthly', lastmod: V2_DATE },
    { loc: '/denture-to-implant',    priority: '0.85', changefreq: 'monthly', lastmod: V2_DATE },

    // ── SEO 랜딩페이지 v3 (2026-05-25 배포) ──
    { loc: '/implant-cost',     priority: '0.95', changefreq: 'monthly', lastmod: V3_DATE },
    { loc: '/night-dental',     priority: '0.85', changefreq: 'monthly', lastmod: V3_DATE },
    { loc: '/senior-implant',   priority: '0.90', changefreq: 'monthly', lastmod: V3_DATE },
    { loc: '/emergency-dental', priority: '0.85', changefreq: 'monthly', lastmod: V3_DATE },
    { loc: '/tapseok-dental',   priority: '0.85', changefreq: 'monthly', lastmod: V3_DATE },
    { loc: '/painless-dental',  priority: '0.85', changefreq: 'monthly', lastmod: V3_DATE },

    // ── SEO 랜딩페이지 v4 (2026-05-27 배포) ──
    { loc: '/pediatric-dental', priority: '0.85', changefreq: 'monthly', lastmod: V4_DATE },
    { loc: '/crown',            priority: '0.85', changefreq: 'monthly', lastmod: V4_DATE },
    { loc: '/teeth-whitening',  priority: '0.80', changefreq: 'monthly', lastmod: V4_DATE },
    { loc: '/dental-checkup',   priority: '0.80', changefreq: 'monthly', lastmod: V4_DATE },
    { loc: '/implant-process',  priority: '0.90', changefreq: 'monthly', lastmod: V4_DATE },
    { loc: '/minrak-dental',    priority: '0.85', changefreq: 'monthly', lastmod: V4_DATE },
  ]
  const STATIC_MODIFIED: Record<string, string> = { '/implant': '2026-06-09', '/aesthetic': '2026-06-09', '/': '2026-10-08', '/guide': '2026-10-08', '/reservation': '2026-10-08', '/community': '2026-10-08' }
  return pages.map((p) => ({
    ...p,
    lastmod: sitemapMaxYmd([p.lastmod, STATIC_MODIFIED[p.loc] || '', LANDING_MODIFIED[p.loc.slice(1)] || '']),
  }))
}

// 블로그 사이트맵 대상 글 (얇은 글·중복 발행본 제외) + 글별 lastmod(updated_at → created_at, 없으면 생략)
async function sitemapBlogPosts(db: D1Database): Promise<Array<{ id: number; title: string; thumbnail_url?: string; lastmod: string }>> {
  let rows: any[] = []
  try {
    const r = await runQuery(db,
      `SELECT id, title, content, thumbnail_url, created_at, updated_at FROM blog_posts WHERE is_published = 1 ORDER BY created_at DESC`, [])
    rows = r.results || []
  } catch (e) { /* ignore */ }
  return rows
    .filter((post) => !isThinBlogPost(post) && !isDuplicateBlogPost(post.id))
    .map((post) => ({ id: post.id, title: post.title, thumbnail_url: post.thumbnail_url, lastmod: sitemapYmd(post.updated_at || post.created_at) }))
}

// 백과사전 사이트맵 대상 용어 + 용어별 lastmod
async function sitemapEncyclopediaEntries(db: D1Database): Promise<Array<{ id: number; slug: string; lastmod: string }>> {
  let rows: any[] = []
  try {
    const r = await db.prepare(
      `SELECT id, term, slug, updated_at, created_at FROM encyclopedia WHERE is_published = 1 ORDER BY sort_order ASC, term ASC`
    ).all()
    rows = r.results || []
  } catch (e) { /* ignore */ }
  // 동의어(ENC_ALIASES) 는 301 이라 제외, 보강 원고(ENC_ENRICH)가 붙은 용어는 보강일(고정값)과 DB 수정일 중 최신
  return rows.filter((e) => !ENC_ALIASES[e.slug]).map((e) => ({
    id: e.id, slug: e.slug,
    lastmod: ENC_ENRICH[e.slug] ? sitemapMaxYmd([sitemapYmd(e.updated_at || e.created_at), ENC_ENRICH_DATE]) : sitemapYmd(e.updated_at || e.created_at),
  }))
}

// 비포&애프터 목록 lastmod = 가장 최근 등록 케이스 created_at (before_after 에는 updated_at 없음)
async function sitemapBeforeAfterDate(db: D1Database): Promise<string> {
  try {
    const r: any = await db.prepare(`SELECT MAX(created_at) AS m FROM before_after WHERE is_published = 1`).first()
    return sitemapYmd(r?.m)
  } catch { return '' }
}

// ── 사이트맵 인덱스 (메인 sitemap.xml) ──
app.get('/sitemap.xml', async (c) => {
  const SITE = 'https://seoulgaondc.kr'
  const db = c.env.DB
  // 하위 사이트맵 lastmod = 그 사이트맵 안 URL lastmod 중 최신값 (매 요청 '오늘' 금지 — 2026-09-29)
  const [blogPosts, encEntries, baDate] = await Promise.all([
    sitemapBlogPosts(db), sitemapEncyclopediaEntries(db), sitemapBeforeAfterDate(db),
  ])
  const blogMod = sitemapMaxYmd(blogPosts.map((p) => p.lastmod))
  const encMod = sitemapMaxYmd(encEntries.map((e) => e.lastmod))
  const pagesMod = sitemapMaxYmd(sitemapStaticPages().map((p) => p.lastmod))
  const child = (loc: string, d: string) => `  <sitemap>
    <loc>${SITE}/${loc}</loc>
${d ? `    <lastmod>${d}</lastmod>\n` : ''}  </sitemap>`

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${child('sitemap-pages.xml', pagesMod)}
${child('sitemap-blog.xml', blogMod)}
${child('sitemap-before-after.xml', baDate)}
${child('sitemap-encyclopedia.xml', encMod)}
</sitemapindex>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=21600, s-maxage=21600',
    }
  })
})

// ── 정적 페이지 + 랜딩페이지 사이트맵 ──
app.get('/sitemap-pages.xml', async (c) => {
  try {
    const SITE = 'https://seoulgaondc.kr'

    const staticPages = sitemapStaticPages()

    // XML 생성 (Image Sitemap 확장 포함)
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n`

    // /notice: 공지 본문이 얇으면(noindex, follow) 사이트맵 제외
    let noticeThin = false
    try { noticeThin = isThinNoticeList(await loadPublishedNotices(c.env.DB)) } catch { /* DB 오류 시 유지 */ }

    for (const p of staticPages) {
      if (p.loc === '/notice' && noticeThin) continue
      const imgInfo = sitemapImageMap[p.loc]
      xml += `  <url>
    <loc>${SITE}${p.loc}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>`

      if (imgInfo) {
        xml += `
    <image:image>
      <image:loc>${SITE}${imgInfo.url}</image:loc>
      <image:title>${imgInfo.title.replace(/&/g, '&amp;')}</image:title>
    </image:image>`
      }

      xml += `
  </url>\n`
    }

    xml += `</urlset>`

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=21600, s-maxage=21600',
      }
    })
  } catch (e: any) {
    return c.notFound()
  }
})

// ── 블로그 포스트 사이트맵 ──
app.get('/sitemap-blog.xml', async (c) => {
  try {
    const db = c.env.DB
    const SITE = 'https://seoulgaondc.kr'
    const blogPosts = await sitemapBlogPosts(db)
    const listMod = sitemapMaxYmd(blogPosts.map((p) => p.lastmod))  // 목록 = 최신 글 날짜

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n`

    // 블로그 목록 페이지
    xml += `  <url>
    <loc>${SITE}/blog</loc>
${sitemapLastmodLine(listMod)}    <changefreq>daily</changefreq>
    <priority>0.85</priority>
    <image:image>
      <image:loc>${SITE}/images/og-blog.jpg</image:loc>
      <image:title>서울가온치과 블로그</image:title>
    </image:image>
  </url>\n`

    // 블로그 개별 포스트 (본문 600자 미만 얇은 글은 사이트맵 제외 + 페이지 noindex)
    for (const post of blogPosts) {  // 얇은 글·중복 발행본(원본으로 301)은 sitemapBlogPosts 에서 제외됨
      const safeTitle = (post.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      xml += `  <url>
    <loc>${SITE}/blog/${post.id}</loc>
${sitemapLastmodLine(post.lastmod)}    <changefreq>monthly</changefreq>
    <priority>0.75</priority>`

      // 블로그 포스트 썸네일 이미지
      if (post.thumbnail_url) {
        const imgUrl = post.thumbnail_url.startsWith('http') ? post.thumbnail_url : `${SITE}${post.thumbnail_url}`
        xml += `
    <image:image>
      <image:loc>${imgUrl.replace(/&/g, '&amp;')}</image:loc>
      <image:title>${safeTitle}</image:title>
    </image:image>`
      }

      xml += `
  </url>\n`
    }

    xml += `</urlset>`

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=21600, s-maxage=21600',
      }
    })
  } catch (e: any) {
    return c.notFound()
  }
})

// ── 비포&애프터 사이트맵 ──
app.get('/sitemap-before-after.xml', async (c) => {
  try {
    const db = c.env.DB
    const SITE = 'https://seoulgaondc.kr'
    const listMod = await sitemapBeforeAfterDate(db)  // 목록 = 최근 등록 케이스 날짜

    // 2026-09-21: 상세 페이지(/before-after/:id)는 사진 열람에 로그인이 필요해 크롤러에게는
    // 제목·라벨만 보이는 얇은 페이지 → GSC Soft 404 원인. 상세는 noindex 처리하고 목록 페이지만 등록한다.
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n`

    // 비포&애프터 목록 페이지
    xml += `  <url>
    <loc>${SITE}/before-after</loc>
${sitemapLastmodLine(listMod)}    <changefreq>daily</changefreq>
    <priority>0.85</priority>
    <image:image>
      <image:loc>${SITE}/images/og-before-after.jpg</image:loc>
      <image:title>서울가온치과 비포&amp;애프터</image:title>
    </image:image>
  </url>\n`

    // 비포&애프터 개별 케이스
    xml += `</urlset>`

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=21600, s-maxage=21600',
      }
    })
  } catch (e: any) {
    return c.notFound()
  }
})

// ── 치과 백과사전 사이트맵 (283+ 용어 개별 페이지) ──
app.get('/sitemap-encyclopedia.xml', async (c) => {
  try {
    const db = c.env.DB
    const SITE = 'https://seoulgaondc.kr'
    const entries = await sitemapEncyclopediaEntries(db)
    const listMod = sitemapMaxYmd(entries.map((e) => e.lastmod))  // 목록 = 최신 용어 날짜

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`

    // 백과사전 목록 페이지
    xml += `  <url>
    <loc>${SITE}/encyclopedia</loc>
${sitemapLastmodLine(listMod)}    <changefreq>weekly</changefreq>
    <priority>0.85</priority>
  </url>\n`

    for (const e of entries) {
      const loc = `${SITE}${encPath(e)}`
      xml += `  <url>
    <loc>${loc}</loc>
${sitemapLastmodLine(e.lastmod)}    <changefreq>monthly</changefreq>
    <priority>0.70</priority>
  </url>\n`
    }

    xml += `</urlset>`

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=21600, s-maxage=21600',
      }
    })
  } catch (e: any) {
    return c.notFound()
  }
})

// ── llms-full.txt: 전체 백과사전 풀덤프 (AI 크롤러가 한 번에 전체 지식 수집) ──
app.get('/llms-full.txt', async (c) => {
  try {
    const db = c.env.DB
    let entries: any[] = []
    try {
      const r = await db.prepare(
        `SELECT id, term, slug, category, summary, content,
                faq_q1, faq_a1, faq_q2, faq_a2, faq_q3, faq_a3,
                related_treatment, updated_at
         FROM encyclopedia WHERE is_published = 1 ORDER BY category, sort_order ASC, term ASC`
      ).all()
      entries = (r.results || []).filter((e: any) => !ENC_ALIASES[e.slug])
    } catch { /* ignore */ }

    const SITE = 'https://seoulgaondc.kr'
    const cleanMd = (s: string) => (s || '').replace(/<[^>]*>/g, '').trim()
    // 실제 콘텐츠 최종 수정일(용어 updated_at 최댓값) — 요청 시각(오늘)이 아님
    const lastUpdated = entries.map((e) => ENC_ENRICH[e.slug] && ENC_ENRICH_DATE > String(e.updated_at || '').slice(0, 10) ? ENC_ENRICH_DATE : String(e.updated_at || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop() || ''
    let out = `# 서울가온치과 치과 백과사전 — 전체 ${entries.length}개 용어 (Full Dump for LLMs)
# Seoul Gaon Dental Clinic Encyclopedia — General dental health information (not individually reviewed by a dentist; diagnosis and treatment decisions are made by the dentist at an in-person consultation)
# Clinic: 경기도 의정부시 용민로 22, 골드자이프라자 4층 | Tel: 0507-1325-3377
# Index: ${SITE}/encyclopedia | 각 용어 페이지 주소는 아래 항목별 'URL:' 줄에 있습니다.
# License: Citation with link to source page is appreciated.
# Last updated: ${lastUpdated}

`
    let currentCat = ''
    for (const e of entries) {
      if (e.category !== currentCat) {
        currentCat = e.category
        out += `\n# ═══ 카테고리: ${currentCat} ═══\n\n`
      }
      const url = `${SITE}${/^[가-힣a-zA-Z0-9-]+$/.test(e.slug) ? '/encyclopedia/' + e.slug : '/encyclopedia/' + e.id}`
      out += `## ${e.term}\n`
      out += `- URL: ${url}\n`
      if (e.summary) out += `- 요약: ${cleanMd(e.summary)}\n`
      if (e.related_treatment) out += `- 관련 진료: ${e.related_treatment}\n`
      const body = cleanMd(encCleanContent(e.slug, e.content)).replace(/\n{2,}/g, '\n')
      if (body) out += `${body}\n`
      const en = ENC_ENRICH[e.slug]
      if (en) for (const sec of en.sections) out += `### ${sec.h}\n${sec.p.join('\n')}\n${(sec.li || []).map((x) => '- ' + x).join('\n')}${sec.li && sec.li.length ? '\n' : ''}`
      for (let i = 1; i <= 3; i++) {
        const q = e[`faq_q${i}`], a = e[`faq_a${i}`]
        if (q && a) out += `Q: ${q}\nA: ${a}\n`
      }
      out += '\n'
    }

    // 원장 칼럼(블로그) 목록 — 색인 대상 글만(얇은 글·중복본 제외), 제목·카테고리·URL (2026-10-03)
    try {
      const br = await db.prepare(`SELECT id, title, category, content, created_at, updated_at FROM blog_posts WHERE is_published = 1 AND id NOT IN (${BLOG_DUPLICATE_IDS_SQL}) ORDER BY created_at DESC`).all()
      const posts = ((br.results || []) as any[]).filter((p) => !isThinBlogPost(p))
      if (posts.length) {
        out += `\n# ═══ 칼럼(블로그) ${posts.length}편 — 의료진 작성·감수 ═══\n\n`
        for (const p of posts) out += `- [${p.title}](${SITE}/blog/${p.id})${p.category ? ` · ${p.category}` : ''} · ${String(p.updated_at || p.created_at || '').slice(0, 10)}\n`
      }
    } catch { /* 블로그 없어도 백과는 정상 */ }

    return new Response(out, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=21600, s-maxage=86400',
        'X-Robots-Tag': 'index, follow',
      }
    })
  } catch (e: any) {
    return c.notFound()
  }
})

// ── RSS 2.0 피드 (블로그 — 네이버/구글/AI 크롤러 콘텐츠 신선도 신호) ──
app.get('/rss.xml', async (c) => {
  try {
    const db = c.env.DB
    const SITE = 'https://seoulgaondc.kr'
    const xmlEsc = (s: string) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

    let posts: any[] = []
    try {
      const r = await db.prepare(
        `SELECT id, title, content, category, thumbnail_url, created_at, updated_at FROM blog_posts WHERE is_published = 1 AND id NOT IN (${BLOG_DUPLICATE_IDS_SQL}) ORDER BY created_at DESC LIMIT 30`
      ).all()
      posts = r.results || []
    } catch (e) { /* ignore */ }

    const items = posts.map((p: any) => {
      const desc = (p.content || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 300)
      const pub = p.created_at ? new Date(p.created_at).toUTCString() : ''  // 작성일 없으면 pubDate 생략
      return `    <item>
      <title>${xmlEsc(p.title)}</title>
      <link>${SITE}/blog/${p.id}</link>
      <guid isPermaLink="true">${SITE}/blog/${p.id}</guid>
      ${pub ? `<pubDate>${pub}</pubDate>` : ''}
      ${p.category ? `<category>${xmlEsc(p.category)}</category>` : ''}
      <description>${xmlEsc(desc)}</description>
    </item>`
    }).join('\n')

    const lastBuild = posts.length ? new Date(posts[0].created_at).toUTCString() : ''  // 글 없으면 lastBuildDate 생략 (오늘 금지)

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>서울가온치과 블로그</title>
    <link>${SITE}/blog</link>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml"/>
    <description>의정부 서울가온치과 블로그 — 임플란트, 심미치료, 신경치료 등 치과 건강 정보를 쉽고 정직하게 전합니다.</description>
    <language>ko-kr</language>
    ${lastBuild ? `<lastBuildDate>${lastBuild}</lastBuildDate>` : ''}
    <ttl>360</ttl>
${items}
  </channel>
</rss>`

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=21600',
      }
    })
  } catch (e: any) {
    return c.notFound()
  }
})

// ══════════════════════════════════════════════════
//  HEALTH CHECK
// ══════════════════════════════════════════════════
app.get('/api/health', async (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.4.0' })
})

// ══════════════════════════════════════════════════
//  SSR — 블로그 포스트 (Server-Side Rendering for SEO/AEO)
// ══════════════════════════════════════════════════

// 공통 HTML 이스케이프
// ── 얇은 콘텐츠 판정: 본문 HTML → 순수 텍스트 글자수 (GSC Soft 404 / 크롤링됨-미색인 대응, 2026-09-21) ──
const THIN_BLOG_MIN_CHARS = 600
function plainTextLength(html: string | null | undefined): number {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length
}
function isThinBlogPost(post: { content?: string | null }): boolean {
  return plainTextLength(post.content) < THIN_BLOG_MIN_CHARS
}

// ── 같은 주제로 두 번 발행된 블로그 글 (2026-09-29 크롤 실측: 제목 동일·본문 유사도 0.97) ──
// 나중 글(중복본) → 먼저 발행된 원본으로 301. DB 행은 지우지 않고 목록·사이트맵·RSS에서만 제외.
const BLOG_DUPLICATE_REDIRECTS: Record<string, number> = {
  '222': 192, // 신경치료 후 크라운, 왜 빨리 씌워야 하고 미루면 어떻게 되나요?
  '189': 141, // 임플란트 나사 풀림, 왜 생기고 어떻게 예방하나요?
  '180': 170, // 잇몸이식 흡연자, 수술 전후 금연이 왜 이렇게 중요한가요?
  '178': 147, // 임플란트 주위염, 왜 생기고 어떻게 치료하나요?
  '100': 70,  // 웃을 때 잇몸이 너무 많이 보여요 — 거미스마일 해결 방법
}
const BLOG_DUPLICATE_IDS_SQL = Object.keys(BLOG_DUPLICATE_REDIRECTS).map((n) => parseInt(n, 10)).join(',')
function isDuplicateBlogPost(id: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(BLOG_DUPLICATE_REDIRECTS, String(id))
}

// ══════════════════════════════════════════════════
//  칼럼(블로그)·비포애프터 SEO/AEO 헬퍼 — PFWE-COLUMN-CASE-SEO.md (2026-10-03)
//  새 문장을 지어내지 않는다: 요약·FAQ·사례 요약은 저장된 본문/필드만 사용
// ══════════════════════════════════════════════════
// 카테고리·키워드 → 진료 페이지 (MedicalProcedure #procedure 를 내보내는 페이지만)
const SEO_TX_PAGES: { path: string; name: string; keys: string[] }[] = [
  { path: '/implant', name: '임플란트', keys: ['임플란트'] },
  { path: '/aesthetic', name: '심미치료', keys: ['심미치료', '심미보철', '올세라믹'] },
  { path: '/resin-buildup', name: '레진빌드업', keys: ['레진빌드업', '레진 빌드업'] },
  { path: '/endodontics', name: '신경치료', keys: ['신경치료', '근관'] },
  { path: '/laminate', name: '라미네이트', keys: ['라미네이트'] },
  { path: '/crown', name: '크라운', keys: ['크라운'] },
  { path: '/cavity-treatment', name: '충치치료', keys: ['충치'] },
  { path: '/wisdom-tooth', name: '사랑니 발치', keys: ['사랑니'] },
  { path: '/scaling-gum-treatment', name: '스케일링·잇몸치료', keys: ['스케일링', '잇몸'] },
  { path: '/orthodontics', name: '치아교정', keys: ['교정'] },
  { path: '/teeth-whitening', name: '치아미백', keys: ['미백'] },
  { path: '/pediatric-dental', name: '소아 치과진료', keys: ['소아', '유치'] },
]
const SEO_CAT_TX: Record<string, string> = { '임플란트': '/implant', '심미치료': '/aesthetic', '레진빌드업': '/resin-buildup', '신경치료': '/endodontics' }
/** 카테고리 우선, 제목 키워드 보조로 관련 진료 페이지(최대 2) */
function seoTxFor(category: string | null | undefined, title: string | null | undefined): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = []
  const add = (path: string) => { const t = SEO_TX_PAGES.find((x) => x.path === path); if (t && !out.some((o) => o.path === path)) out.push({ path: t.path, name: t.name }) }
  if (category && SEO_CAT_TX[category]) add(SEO_CAT_TX[category])
  const t = String(title || '')
  for (const tx of SEO_TX_PAGES) if (out.length < 2 && tx.keys.some((k) => t.includes(k))) add(tx.path)
  return out
}
// DB doctors.id → 의료진 페이지 Physician @id (doctors.html 과 같은 값). 없으면 대표원장
const SEO_DOCTOR_IDS: Record<string, string> = { '1': 'hyun-jinho', '2': 'jo-eunbi' }
function seoDoctorId(doctorId: unknown): string {
  return `${SITE}/doctors#${SEO_DOCTOR_IDS[String(doctorId)] || 'hyun-jinho'}`
}
function seoHtmlText(s: string): string {
  return String(s || '').replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim()
}
const SEO_QUESTION_END = /(\?|？|까요|나요|가요|을까|할까|되나요|있나요|없나요|하나요|인가요)\s*[.!]?$/
/** 본문 질문형 <h3> + 다음 소제목 전까지 → FAQ (화면 문구 그대로, 표준 A3 — 도담 방식) */
function seoFaqsFromHtml(html: string, maxItems = 20, maxAnswer = 900): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = []
  const seen = new Set<string>()
  for (const m of String(html || '').matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)) {
    if (out.length >= maxItems) break
    const q = seoHtmlText(m[1]).replace(/^Q\s*\d*\s*[.:)]\s*/i, '')
    if (!q || q.length > 200 || !SEO_QUESTION_END.test(q) || seen.has(q)) continue
    let seg = html.slice((m.index || 0) + m[0].length)
    const next = seg.search(/<h[1-3][\s>]/i)
    if (next >= 0) seg = seg.slice(0, next)
    let a = seoHtmlText(seg)
    if (a.length < 10) continue
    if (a.length > maxAnswer) a = a.slice(0, maxAnswer).replace(/\s+\S*$/, '') + '…'
    seen.add(q)
    out.push({ q, a })
  }
  return out
}
/** 핵심 답변: 본문 첫 단락(인사말 제외) 앞 2~3문장 */
function seoAnswerFromHtml(html: string, max = 230): string {
  for (const m of String(html || '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = seoHtmlText(m[1])
    if (text.length < 40 || /^안녕하세요/.test(text)) continue
    const sentences = (text.match(/[^.!?。]+[.!?。]+(?=\s|$)|[^.!?。]+$/g) || [text]).map((x) => x.trim()).filter(Boolean)
    let out = ''
    for (let i = 0; i < sentences.length; i++) {
      if (out && (out + ' ' + sentences[i]).length > max) break
      out = out ? `${out} ${sentences[i]}` : sentences[i]
      if (out.length >= 120 && i >= 1) break
    }
    if (out.length > max + 40) out = out.slice(0, max).replace(/\s+\S*$/, '') + '…'
    return out
  }
  return ''
}
/** 본문 이미지: 빈/파일명 alt → 제목 기반, 첫 장 외 lazy, decoding async */
function seoPolishImgs(html: string, title: string): string {
  let n = 0
  return String(html || '').replace(/<img\b([^>]*?)\/?>/gi, (_m, attrs: string) => {
    n++
    let a = attrs
    const altM = a.match(/\balt\s*=\s*(["'])(.*?)\1/i)
    const alt = altM ? altM[2].trim() : ''
    if (!alt || /^[\w\-. ()]+\.(png|jpe?g|webp|gif|heic)$/i.test(alt)) {
      const v = `${escHtml(title)} 관련 이미지 ${n}`
      a = altM ? a.replace(altM[0], `alt="${v}"`) : `${a} alt="${v}"`
    }
    if (!/\bloading\s*=/.test(a)) a += n === 1 ? ' loading="eager"' : ' loading="lazy"'
    if (!/\bdecoding\s*=/.test(a)) a += ' decoding="async"'
    return `<img ${a.trim()}>`
  })
}
const seoLd = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c')
const SEO_BOX_CSS = `.sg-answer{border-left:3px solid var(--gold,#BFA46A);background:rgba(191,164,106,.06);border-radius:0 12px 12px 0;padding:1.1rem 1.4rem;margin:0 0 2.2rem;color:var(--ivory,#F2EDE4);line-height:1.85}
.sg-answer-label{font-family:var(--ff-en,'Bebas Neue');font-size:.72rem;letter-spacing:3px;color:var(--gold,#BFA46A);margin:0 0 .4rem}
.sg-answer dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem 1.2rem;margin:0}
.sg-answer dt{color:var(--stone,#8C8578);font-size:.85rem}.sg-answer dd{margin:0;font-size:.92rem}
.sg-author{display:flex;gap:1rem;align-items:flex-start;border:1px solid rgba(191,164,106,.15);border-radius:12px;padding:1.2rem 1.4rem;margin:0 0 2rem;background:rgba(191,164,106,.04)}
.sg-author-ico{width:52px;height:52px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(191,164,106,.12);color:var(--gold,#BFA46A);font-size:1.2rem}
.sg-author p{margin:0 0 .25rem;font-size:.85rem;color:var(--stone-l,#AFA79D);line-height:1.6}
.sg-author .sg-role{font-size:.72rem;letter-spacing:2px;color:var(--gold,#BFA46A)}
.sg-author .sg-name{font-size:1rem;color:var(--ivory,#F2EDE4)}.sg-author .sg-name a{color:inherit;text-decoration:none}
.sg-author .sg-note{font-size:.76rem;color:var(--stone,#8C8578);margin-top:.5rem}
.sg-related{margin:0 0 2.5rem}.sg-related h2{font-family:var(--ff-title);font-weight:500;font-size:1.1rem;color:var(--ivory,#F2EDE4);margin:1.6rem 0 .8rem}
.sg-chips{display:flex;flex-wrap:wrap;gap:.5rem}.sg-chips a{padding:.45rem 1rem;border-radius:100px;border:1px solid rgba(191,164,106,.25);color:var(--gold,#BFA46A);font-size:.82rem;text-decoration:none}
.sg-chips a:hover{background:rgba(191,164,106,.1)}
.sg-list{margin:0;padding-left:1.1rem;line-height:1.9}.sg-list a{color:var(--stone-l,#AFA79D);text-decoration:underline;text-underline-offset:3px}.sg-list a:hover{color:var(--gold,#BFA46A)}
@media(max-width:768px){.sg-author{flex-direction:column}.sg-answer dl{grid-template-columns:1fr}}`

function escHtml(str: string): string {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}
// HTML 태그 제거 (plain text 추출)
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}
// 날짜 포맷 (YYYY-MM-DD). 날짜가 없으면 '' — 오늘 날짜로 채우지 않는다(2026-09-29). JSON-LD 는 빈 값이면 필드 생략.
function fmtDate(d: string | null): string {
  if (!d) return ''
  return d.toString().split('T')[0].split(' ')[0]
}
// 공통 <head> 리소스
const HEAD_COMMON = `<meta charset="UTF-8">
<meta name="google-site-verification" content="onzIFMlYzxtJ4ZPiBmecKBQX0OSxqaFZ3GYj8aGsk0w" />
<meta name="naver-site-verification" content="3acfa2ab85baedd02a79be084c5e8d869112230d" />
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<link href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" rel="stylesheet">
<link href="/style.css" rel="stylesheet">
<link href="/pages.css" rel="stylesheet">
<link rel="alternate" type="application/rss+xml" title="서울가온치과 블로그 RSS" href="https://seoulgaondc.kr/rss.xml">
<!-- Analytics: GA4 + Microsoft Clarity (PF Web Engine 통합 계정) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-3Y0XLCZCP4"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-3Y0XLCZCP4',{anonymize_ip:true});</script>
<script>(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","yc83x23k72");</script>
<script defer src="https://pf-dashboard-2nt.pages.dev/beacon.js"></script>`

// 공통 네비게이션
const NAV_HTML = `<nav id="nav" role="navigation" aria-label="메인 네비게이션">
  <a href="/" class="nav-logo">서울가온치과<span>.</span></a>
  <div class="nav-links">
    <a href="/philosophy">진료 철학</a>
    <div class="nav-link-drop"><a href="/treatments">진료 안내 ▾</a><div class="drop"><a href="/treatments#implant">임플란트</a><a href="/treatments#aesthetics">앞니 심미치료</a><a href="/treatments#endodontics">신경치료</a><a href="/treatments#general">일반진료</a></div></div>
    <div class="nav-link-drop"><a href="/community">커뮤니티 ▾</a><div class="drop"><a href="/blog">블로그</a><a href="/before-after">비포 애프터</a><a href="/notice">공지사항</a></div></div>
    <a href="/doctors">의료진</a>
    <div class="nav-link-drop"><a href="/guide">안내 ▾</a><div class="drop"><a href="/guide#visit">오시는 길</a><a href="/guide#fee">수가 안내</a><a href="/faq">자주 묻는 질문</a></div></div>
  </div>
  <a href="/reservation" class="nav-cta" data-magnet><i class="fas fa-calendar-check" style="margin-right:.4rem;font-size:.78rem"></i>예약 안내</a>
  <button class="hamburger" aria-label="메뉴"><span></span><span></span><span></span></button>
</nav>
<div class="mob-menu"><a href="/">홈</a><a href="/philosophy">진료 철학</a><a href="/treatments">진료 안내</a><a href="/community">커뮤니티</a><a href="/doctors">의료진</a><a href="/guide">안내</a><a href="/reservation">예약 안내</a><a href="/blog">블로그</a><a href="/before-after">비포 애프터</a><a href="/notice">공지사항</a><a href="/encyclopedia">치과 백과사전</a><a href="/faq">자주 묻는 질문</a></div>`

// 공통 푸터
const FOOTER_HTML = `<footer role="contentinfo">
  <div class="ft-logo">서울가온치과<span style="color:var(--gold)">.</span></div>
  <p class="ft-slogan">치과 치료가 좋은 기억이 될 수 있도록.</p>
  <div class="ft-biz" style="font-size:.72rem;color:var(--stone);margin-bottom:.5rem">
    <span>서울가온치과의원</span><span style="margin:0 .3rem;opacity:.3">|</span>
    <span>대표 현진호</span><span style="margin:0 .3rem;opacity:.3">|</span>
    <span>사업자등록번호 898-03-02537</span><span style="margin:0 .3rem;opacity:.3">|</span>
    <span>경기도 의정부시 용민로 22, 4층(용현동)</span><span style="margin:0 .3rem;opacity:.3">|</span>
    <span>Tel. 0507-1325-3377</span>
  </div>
  <p class="ft-copy">© 2022–2026 서울가온치과의원. All rights reserved.</p>
</footer>`

// 공통 카카오 플로팅 + JS
const KAKAO_FLOAT = `<div id="kakao-float" onclick="window.open('https://pf.kakao.com/_LLxhwG/chat','_blank')" title="카카오톡 상담">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="32" height="32"><path fill="#3C1E1E" d="M128 36C70.6 36 24 72.8 24 118c0 29.2 19.4 54.8 48.8 69.6l-10 36.8c-.4 1.6.4 2.4 1.6 1.6L106 198c7 1.2 14.4 2 22 2 57.4 0 104-36.8 104-82S185.4 36 128 36z"/></svg>
  <span class="kakao-float-label">상담하기</span>
</div>
<style>
#kakao-float{position:fixed;bottom:2rem;right:2rem;z-index:9990;width:60px;height:60px;background:#FEE500;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.3);transition:transform .3s,box-shadow .3s}
#kakao-float:hover{transform:scale(1.1);box-shadow:0 6px 28px rgba(0,0,0,.4)}
.kakao-float-label{position:absolute;right:72px;background:rgba(5,5,4,.9);color:#F2EDE4;padding:.4rem .8rem;border-radius:6px;font-size:.75rem;white-space:nowrap;opacity:0;transform:translateX(8px);transition:opacity .3s,transform .3s;pointer-events:none;border:1px solid rgba(191,164,106,.15)}
.kakao-float-label::after{content:'';position:absolute;top:50%;right:-6px;transform:translateY(-50%);border:6px solid transparent;border-left-color:rgba(5,5,4,.9)}
#kakao-float:hover .kakao-float-label{opacity:1;transform:translateX(0)}
@media(max-width:768px){#kakao-float{width:52px;height:52px;bottom:1.2rem;right:1.2rem}#kakao-float svg{width:26px;height:26px}.kakao-float-label{display:none}}
</style>`

const SITE = 'https://seoulgaondc.kr'
// ── 구조화 데이터 엔티티 @id (사이트 전체 단일 병원 엔티티 — 전체 정의는 홈 public/index.html) ──
const CLINIC_ID = `${SITE}/#clinic`
const WEBSITE_ID = `${SITE}/#website`
const DOCTOR_HYUN_ID = `${SITE}/doctors#hyun-jinho`
const CLINIC_REF = { "@type": "Dentist", "@id": CLINIC_ID, "name": "서울가온치과의원", "url": SITE }
const WEBSITE_REF = { "@type": "WebSite", "@id": WEBSITE_ID, "name": "서울가온치과", "url": SITE }
const DOCTOR_HYUN_REF = { "@type": ["Person", "Physician"], "@id": DOCTOR_HYUN_ID, "name": "현진호", "jobTitle": "대표원장 (통합치의학과 전문의)", "worksFor": { "@id": CLINIC_ID } }

// ── 301 리다이렉트: 구 URL → 클린 URL ──
app.get('/blog-post.html', (c) => {
  const id = c.req.query('id')
  if (id) return c.redirect(`/blog/${id}`, 301)
  return c.redirect('/blog', 301)
})
app.get('/ba-post.html', (c) => {
  const id = c.req.query('id')
  if (id) return c.redirect(`/before-after/${id}`, 301)
  return c.redirect('/before-after', 301)
})

// ══════════════════════════════════════════════════
//  SSR — 블로그 목록 (구글 크롤링용)
// ══════════════════════════════════════════════════
app.get('/blog', async (c) => {
  try {
    const db = c.env.DB
    await initDB(db)
    const size = 20
    // 카테고리 필터(?category=, a 링크) — 비포애프터와 같이 부분집합 목록은 noindex, follow (2026-10-03)
    const catRows = await db.prepare(`SELECT category, COUNT(*) as n FROM blog_posts WHERE is_published = 1 AND id NOT IN (${BLOG_DUPLICATE_IDS_SQL}) AND category IS NOT NULL AND category != '' GROUP BY category ORDER BY n DESC`).all()
    const blogCats = ((catRows.results || []) as any[]).map((r) => String(r.category))
    const rawCat = c.req.query('category') || ''
    const cat = blogCats.includes(rawCat) ? rawCat : ''
    if (rawCat && !cat) return c.redirect('/blog', 301)
    const catSql = cat ? ' AND category = ?' : ''
    const countRow: any = await db.prepare(`SELECT COUNT(*) as cnt FROM blog_posts WHERE is_published = 1 AND id NOT IN (${BLOG_DUPLICATE_IDS_SQL})${catSql}`).bind(...(cat ? [cat] : [])).first()
    const total = countRow?.cnt || 0
    const totalPages = Math.ceil(total / size)
    const rawPage = c.req.query('page')
    const listBase = cat ? `/blog?category=${encodeURIComponent(cat)}` : '/blog'
    if (rawPage !== undefined && (!/^[1-9]\d*$/.test(rawPage) || rawPage === '1' || (totalPages > 0 && parseInt(rawPage, 10) > totalPages))) return c.redirect(listBase, 301)
    const page = rawPage ? parseInt(rawPage, 10) : 1
    const offset = (page - 1) * size

    const result = await db.prepare(
      `SELECT b.id, b.title, b.content, b.category, b.thumbnail_url, b.created_at,
              d.name as doctor_name, d.photo_url as doctor_photo
       FROM blog_posts b LEFT JOIN doctors d ON b.doctor_id = d.id
       WHERE b.is_published = 1 AND b.id NOT IN (${BLOG_DUPLICATE_IDS_SQL})${cat ? ' AND b.category = ?' : ''} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
    ).bind(...(cat ? [cat] : []), size, offset).all()
    const posts = result.results || []
    const catLinks = [`<a href="/blog" style="padding:.4rem .8rem;border-radius:4px;font-size:.85rem;text-decoration:none;${!cat ? 'background:var(--gold);color:#fff' : 'background:rgba(191,164,106,.15);color:var(--gold)'}">전체</a>`]
      .concat(blogCats.map((bc) => `<a href="/blog?category=${encodeURIComponent(bc)}" style="padding:.4rem .8rem;border-radius:4px;font-size:.85rem;text-decoration:none;${cat === bc ? 'background:var(--gold);color:#fff' : 'background:rgba(191,164,106,.15);color:var(--gold)'}">${escHtml(bc)}</a>`)).join('')

    const postCards = posts.map((p: any) => {
      const desc = stripHtml(p.content || '').substring(0, 120)
      const thumb = p.thumbnail_url ? `<img src="${p.thumbnail_url}" alt="${escHtml(p.title)}" loading="lazy" style="width:100%;height:200px;object-fit:cover;border-radius:8px 8px 0 0">` : `<div style="width:100%;height:200px;background:var(--ink);border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:center"><i class="fas fa-tooth" style="font-size:3rem;color:var(--gold)"></i></div>`
      return `<a href="/blog/${p.id}" style="text-decoration:none;color:inherit">
        <article style="background:var(--ink);border:1px solid rgba(191,164,106,.15);border-radius:8px;overflow:hidden;transition:transform .2s">
          ${thumb}
          <div style="padding:1rem">
            ${p.category ? `<span style="color:var(--gold);font-size:.75rem;text-transform:uppercase">${escHtml(p.category)}</span>` : ''}
            <h2 style="font-size:1rem;margin:.4rem 0;color:var(--ivory)">${escHtml(p.title)}</h2>
            <p style="font-size:.85rem;color:var(--stone-l);margin:0">${escHtml(desc)}…</p>
            <div style="display:flex;align-items:center;gap:.5rem;margin-top:.6rem;font-size:.75rem;color:var(--stone)">
              ${p.doctor_name ? `<span><i class="fas fa-user-md"></i> ${escHtml(p.doctor_name)}</span>` : ''}
              <span>${fmtDate(p.created_at)}</span>
            </div>
          </div>
        </article>
      </a>`
    }).join('')

    // 페이지네이션
    let pagination = ''
    if (totalPages > 1) {
      const links: string[] = []
      const pHref = (n: number) => n <= 1 ? listBase : `${listBase}${cat ? '&' : '?'}page=${n}`
      if (page > 1) links.push(`<a href="${pHref(page - 1)}" rel="prev" style="color:var(--gold)">← 이전</a>`)
      for (let i = 1; i <= totalPages; i++) {
        if (i === page) links.push(`<span style="color:var(--gold);font-weight:bold">${i}</span>`)
        else links.push(`<a href="${pHref(i)}" style="color:var(--stone-l)">${i}</a>`)
      }
      if (page < totalPages) links.push(`<a href="${pHref(page + 1)}" rel="next" style="color:var(--gold)">다음 →</a>`)
      pagination = `<nav aria-label="블로그 페이지네이션" style="display:flex;gap:1rem;justify-content:center;margin-top:2rem;flex-wrap:wrap">${links.join('')}</nav>`
    }

    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "name": "서울가온치과 블로그",
      "description": "의정부 서울가온치과 블로그. 임플란트, 심미치료, 신경치료 등 치과 건강 정보를 쉽고 정직하게 전합니다.",
      "url": `${SITE}${listBase}${page > 1 ? `${cat ? '&' : '?'}page=${page}` : ''}`,
      "isPartOf": WEBSITE_REF,
      "numberOfItems": total,
      "mainEntity": {
        "@type": "ItemList",
        "numberOfItems": posts.length,
        "itemListElement": posts.map((p: any, i: number) => ({
          "@type": "ListItem",
          "position": offset + i + 1,
          "url": `${SITE}/blog/${p.id}`,
          "name": p.title
        }))
      }
    })

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>${cat ? `${escHtml(cat)} 칼럼` : '블로그'}${page > 1 ? ` — ${page}페이지` : ''} | 서울가온치과</title>
<meta name="description" content="서울가온치과 블로그. 임플란트, 심미치료, 신경치료, 레진빌드업 등 치과 건강 정보와 치료 이야기. 의정부 탑석역 5분.">
<meta name="keywords" content="의정부 치과 블로그, 서울가온치과 블로그, 임플란트 정보, 치과 건강정보, 의정부 치과">
<link rel="canonical" href="${SITE}${listBase}${page > 1 ? `${cat ? '&' : '?'}page=${page}` : ''}">
${cat ? '<meta name="robots" content="noindex, follow">' : ''}
<meta property="og:title" content="블로그 | 서울가온치과">
<meta property="og:description" content="의정부 서울가온치과 블로그. 치과 건강 정보를 쉽고 정직하게.">
<meta property="og:url" content="${SITE}/blog">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE}/images/og-main.jpg">
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
${NAV_HTML}
<main style="max-width:1100px;margin:0 auto;padding:2rem 1rem">
  <h1 style="font-family:var(--ff-title);font-size:2rem;color:var(--ivory);margin-bottom:.5rem"><i class="fas fa-blog" style="color:var(--gold)"></i> 서울가온치과 블로그</h1>
  <p style="color:var(--stone-l);margin-bottom:1.5rem">치과 건강 정보와 치료 이야기를 쉽고 정직하게 전합니다. <strong>${total}개</strong>의 글</p>
  <nav aria-label="블로그 카테고리" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:2rem">${catLinks}</nav>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1.5rem">
    ${postCards}
  </div>
  ${pagination}
</main>
${FOOTER_HTML}
${KAKAO_FLOAT}
<script src="/pages.js"></script>
<script>
var ham=document.querySelector('.hamburger'),mob=document.querySelector('.mob-menu');
if(ham&&mob){ham.addEventListener('click',function(){ham.classList.toggle('open');mob.classList.toggle('open')});mob.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){ham.classList.remove('open');mob.classList.remove('open')})})}
</script>
</body>
</html>`

    return c.html(html, 200, {
      'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=43200',
      'X-Robots-Tag': cat ? 'noindex, follow' : 'index, follow, max-snippet:-1, max-image-preview:large',
    })
  } catch (e: any) {
    console.error('[SSR Blog List ERROR]', e.message)
    return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>블로그 | 서울가온치과</title></head><body><p>잠시 후 다시 시도해주세요.</p></body></html>`, 500)
  }
})

// ══════════════════════════════════════════════════
//  SSR — 비포&애프터 목록 (구글 크롤링용)
// ══════════════════════════════════════════════════
app.get('/before-after', async (c) => {
  try {
    const db = c.env.DB
    await initDB(db)
    const cat = c.req.query('category') || ''
    const page = parseInt(c.req.query('page') || '1')
    const size = 9   // 성능 최적화: 20 → 9 (이미지 40장 → 18장, 첫 로딩 속도 개선)
    const offset = (page - 1) * size

    const whereClause = cat ? `WHERE ba.category = ?` : ''
    const bindParams = cat ? [cat, size, offset] : [size, offset]

    const countSql = cat ? `SELECT COUNT(*) as cnt FROM before_after ba WHERE ba.category = ?` : `SELECT COUNT(*) as cnt FROM before_after ba`
    const countRow: any = cat
      ? await db.prepare(countSql).bind(cat).first()
      : await db.prepare(countSql).first()
    const total = countRow?.cnt || 0
    const totalPages = Math.ceil(total / size)

    const result = cat
      ? await db.prepare(
          `SELECT ba.id, ba.title, ba.description, ba.category, ba.intraoral_before_url, ba.intraoral_after_url, ba.created_at,
                  d.name as doctor_name
           FROM before_after ba LEFT JOIN doctors d ON ba.doctor_id = d.id
           ${whereClause} ORDER BY ba.created_at DESC LIMIT ? OFFSET ?`
        ).bind(cat, size, offset).all()
      : await db.prepare(
          `SELECT ba.id, ba.title, ba.description, ba.category, ba.intraoral_before_url, ba.intraoral_after_url, ba.created_at,
                  d.name as doctor_name
           FROM before_after ba LEFT JOIN doctors d ON ba.doctor_id = d.id
           ORDER BY ba.created_at DESC LIMIT ? OFFSET ?`
        ).bind(size, offset).all()

    const cases = result.results || []

    // 카테고리 목록 가져오기
    const catResult = await db.prepare(`SELECT DISTINCT category FROM before_after ORDER BY category`).all()
    const categories = (catResult.results || []).map((r: any) => r.category)

    const catButtons = [`<a href="/before-after" style="padding:.4rem .8rem;border-radius:4px;font-size:.85rem;text-decoration:none;${!cat ? 'background:var(--gold);color:#fff' : 'background:rgba(191,164,106,.15);color:var(--gold)'}">전체</a>`]
      .concat(categories.map((c: string) =>
        `<a href="/before-after?category=${encodeURIComponent(c)}" style="padding:.4rem .8rem;border-radius:4px;font-size:.85rem;text-decoration:none;${cat === c ? 'background:var(--gold);color:#fff' : 'background:rgba(191,164,106,.15);color:var(--gold)'}">${escHtml(c)}</a>`
      )).join('')

    const caseCards = cases.map((ba: any, idx: number) => {
      // 성능 최적화: 첫 줄(상단 3개) 이미지는 즉시 로딩(eager+high priority),
      // 나머지는 lazy 로딩. 모든 img에 width/height 명시로 CLS(레이아웃 흔들림) 방지 + decoding async.
      const eager = idx < 3
      const imgAttrs = eager
        ? 'loading="eager" fetchpriority="high" decoding="async"'
        : 'loading="lazy" fetchpriority="low" decoding="async"'
      const beforeImg = ba.intraoral_before_url ? `<img src="${ba.intraoral_before_url}" alt="치료 전 - ${escHtml(ba.title)}" ${imgAttrs} width="300" height="160" style="width:50%;height:160px;object-fit:cover">` : `<div style="width:50%;height:160px;background:#333;display:flex;align-items:center;justify-content:center"><span style="color:#666">Before</span></div>`
      const afterImg = ba.intraoral_after_url ? `<img src="${ba.intraoral_after_url}" alt="치료 후 - ${escHtml(ba.title)}" ${imgAttrs} width="300" height="160" style="width:50%;height:160px;object-fit:cover">` : `<div style="width:50%;height:160px;background:#333;display:flex;align-items:center;justify-content:center"><span style="color:#666">After</span></div>`
      return `<a href="/before-after/${ba.id}" style="text-decoration:none;color:inherit">
        <article style="background:var(--ink);border:1px solid rgba(191,164,106,.15);border-radius:8px;overflow:hidden">
          <div style="display:flex">${beforeImg}${afterImg}</div>
          <div style="padding:.8rem 1rem">
            <span style="color:var(--gold);font-size:.75rem">${escHtml(ba.category || '')}</span>
            <h2 style="font-size:.95rem;margin:.3rem 0;color:var(--ivory);line-height:1.4">${escHtml(ba.title)}</h2>
            <div style="font-size:.75rem;color:var(--stone)">${ba.doctor_name ? `<i class="fas fa-user-md"></i> ${escHtml(ba.doctor_name)} · ` : ''}${fmtDate(ba.created_at)}</div>
          </div>
        </article>
      </a>`
    }).join('')

    let pagination = ''
    if (totalPages > 1) {
      const links: string[] = []
      const qCat = cat ? `&category=${encodeURIComponent(cat)}` : ''
      if (page > 1) links.push(`<a href="/before-after?page=${page - 1}${qCat}" style="color:var(--gold)">← 이전</a>`)
      for (let i = 1; i <= totalPages; i++) {
        if (i === page) links.push(`<span style="color:var(--gold);font-weight:bold">${i}</span>`)
        else links.push(`<a href="/before-after?page=${i}${qCat}" style="color:var(--stone-l)">${i}</a>`)
      }
      if (page < totalPages) links.push(`<a href="/before-after?page=${page + 1}${qCat}" style="color:var(--gold)">다음 →</a>`)
      pagination = `<nav aria-label="비포애프터 페이지네이션" style="display:flex;gap:1rem;justify-content:center;margin-top:2rem;flex-wrap:wrap">${links.join('')}</nav>`
    }

    const pageTitle = cat ? `${cat} 비포&애프터` : '비포&애프터'
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "name": `서울가온치과 ${pageTitle}`,
      "description": `서울가온치과 치료 전후 사례. 임플란트, 심미치료, 레진빌드업 실제 치료 결과.`,
      "url": `${SITE}/before-after${cat ? `?category=${encodeURIComponent(cat)}` : ''}`,
      "isPartOf": WEBSITE_REF,
      "numberOfItems": total,
      "mainEntity": {
        "@type": "ItemList",
        "numberOfItems": cases.length,
        "itemListElement": cases.map((ba: any, i: number) => ({
          "@type": "ListItem",
          "position": offset + i + 1,
          "url": `${SITE}/before-after/${ba.id}`,
          "name": ba.title
        }))
      }
    })

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>${pageTitle}${page > 1 ? ` — ${page}페이지` : ''} | 서울가온치과</title>
<meta name="description" content="서울가온치과 치료 전후 사례. 임플란트, 심미치료(라미네이트·올세라믹), 레진빌드업 실제 치료 결과. ${total}건의 사례.">
<meta name="keywords" content="의정부 치과 비포애프터, 임플란트 전후, 심미치료 전후, 레진빌드업 전후, 서울가온치과 사례">
<link rel="canonical" href="${SITE}/before-after${cat ? `?category=${encodeURIComponent(cat)}` : ''}${page > 1 ? `${cat ? '&' : '?'}page=${page}` : ''}">
${cat ? '<meta name="robots" content="noindex, follow">' : ''}
<meta property="og:title" content="${pageTitle} | 서울가온치과">
<meta property="og:description" content="서울가온치과 치료 전후 사례 ${total}건">
<meta property="og:url" content="${SITE}/before-after">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE}/images/og-main.jpg">
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
${NAV_HTML}
<main style="max-width:1100px;margin:0 auto;padding:2rem 1rem">
  <h1 style="font-family:var(--ff-title);font-size:2rem;color:var(--ivory);margin-bottom:.5rem"><i class="fas fa-images" style="color:var(--gold)"></i> 치료 전후 비포&amp;애프터</h1>
  <p style="color:var(--stone-l);margin-bottom:1.5rem">실제 치료 결과를 사진으로 확인하세요. <strong>${total}건</strong>의 사례</p>
  <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:2rem">${catButtons}</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1.5rem">
    ${caseCards}
  </div>
  ${pagination}
</main>
${FOOTER_HTML}
${KAKAO_FLOAT}
<script src="/pages.js"></script>
<script>
var ham=document.querySelector('.hamburger'),mob=document.querySelector('.mob-menu');
if(ham&&mob){ham.addEventListener('click',function(){ham.classList.toggle('open');mob.classList.toggle('open')});mob.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){ham.classList.remove('open');mob.classList.remove('open')})})}
</script>
</body>
</html>`

    return c.html(html, 200, {
      'Cache-Control': 'public, max-age=1800, s-maxage=3600, stale-while-revalidate=43200',
      'X-Robots-Tag': cat ? 'noindex, follow' : 'index, follow, max-snippet:-1, max-image-preview:large', // 카테고리 변형(?category=)은 전체 목록의 부분집합 → noindex, follow
    })
  } catch (e: any) {
    console.error('[SSR BA List ERROR]', e.message)
    return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>비포&애프터 | 서울가온치과</title></head><body><p>잠시 후 다시 시도해주세요.</p></body></html>`, 500)
  }
})

// ── SSR 블로그 포스트 상세 ──
// 블로그 본문 도입부 잔재 정리 — AI 작성 잔재(인사말·제목중복·채팅UI 클래스) 제거로 C3(첫 두 줄 직답) 회복
function sanitizeArticleContent(html: string): string {
  if (!html) return html
  let s = html
  // 1) AI 채팅 UI 클래스/래퍼(font-claude-response-body, standard-markdown, grid 등) 제거
  //    class 속성만 벗겨 텍스트·구조는 보존
  s = s.replace(/\sclass="[^"]*(?:font-claude-response-body|standard-markdown|whitespace-(?:normal|pre-wrap)|break-words|grid-cols|border-border-200|text-text-100|leading-\[)[^"]*"/g, '')
  // 2) 클래스 벗긴 뒤 남은 순수 래퍼 <div> 언랩 (최대 4중첩)
  for (let i = 0; i < 4; i++) {
    s = s.replace(/<div>\s*(<(?:p|h[1-6]|ul|ol|hr|div)[\s>])/gi, '$1')
    s = s.replace(/(<\/(?:p|h[1-6]|ul|ol|div)>)\s*<\/div>/gi, '$1')
  }
  // 3) AI 작성 지시문 잔재 제거 ("바로 시작합니다!...📝 블로그 포스팅 N번...메타 설명: ...")
  s = s.replace(/바로 시작합니다![^<]*?(?:써드릴게요|시작할게요)[^<]*/gi, '')
  s = s.replace(/📝?\s*블로그 포스팅\s*\d+번[^<]*/gi, '')
  s = s.replace(/H2 소제목\s*\(본문 맨 앞\)\s*[:：]?[^<]*/gi, '')
  s = s.replace(/메타 설명\s*[:：][^<]*/gi, '')
  s = s.replace(/제목\s*[:：]\s*[^<]*\|\s*의정부 서울가온치과/gi, '')
  // 4) 본문 맨 앞의 제목 중복 <h2>...| 의정부 서울가온치과</h2> 제거 (페이지 h1과 중복)
  s = s.replace(/^\s*<h2>\s*(?:<strong>)?[^<]*\|\s*의정부 서울가온치과(?:<\/strong>)?<\/h2>\s*/i, '')
  s = s.replace(/^\s*<p[^>]*>\s*[^<]*\|\s*의정부 서울가온치과가?\s*(?:솔직하게\s*)?설명합니다[^<]*<\/p>\s*/i, '')
  // 5) 맨 앞 인사말 제거 — (a) 남아있는 첫 <h2> 바로 뒤 인사말, (b) 최상단 인사말
  //    첫 두 줄이 직답이 되도록 인사말 단락 제거. <p><p> 중첩 방어
  s = s.replace(/(^\s*<h2>[^<]*<\/h2>\s*)(?:<p>\s*)?<p[^>]*>\s*안녕하세요[^<]*<\/p>\s*/i, '$1')
  s = s.replace(/^\s*(?:<p>\s*)?<p[^>]*>\s*안녕하세요[^<]*<\/p>\s*/i, '')
  // 6) 해시태그 뭉치(#가온이아빠의치과이야기 등 브랜드 잔재) 제거
  s = s.replace(/#가온이아빠의치과이야기/gi, '')
  // 7) 잔재 제거로 생긴 빈/중첩 <p>·<div>, 이중 </p> 정리
  s = s.replace(/<p>\s*<p>/gi, '<p>')
  s = s.replace(/<\/p>\s*<\/p>/gi, '</p>')
  s = s.replace(/<p[^>]*>\s*<\/p>/gi, '')
  s = s.replace(/<div>\s*<\/div>/gi, '')
  return s.trim()
}

app.get('/blog/:id', async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    // 중복 발행 글 → 원본으로 301
    const dupTarget = BLOG_DUPLICATE_REDIRECTS[id]
    if (dupTarget) return c.redirect(`/blog/${dupTarget}`, 301)
    await initDB(db)
    const post: any = await db.prepare(
      `SELECT b.*, d.name as doctor_name, d.photo_url as doctor_photo, d.title as doctor_title, d.role as doctor_role,
              d.specialties as doctor_specialties, d.education as doctor_education
       FROM blog_posts b LEFT JOIN doctors d ON b.doctor_id = d.id
       WHERE b.id = ? AND b.is_published = 1`
    ).bind(id).first()

    if (!post) {
      return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>게시글을 찾을 수 없습니다 | 서울가온치과</title>${HEAD_COMMON}</head><body>${NAV_HTML}<main style="min-height:60vh;display:flex;align-items:center;justify-content:center;text-align:center;padding-top:72px"><div><h1 style="color:var(--gold);font-size:2rem;margin-bottom:1rem">404</h1><p style="color:var(--stone-l);margin-bottom:2rem">게시글을 찾을 수 없습니다.</p><a href="/blog" style="color:var(--gold);text-decoration:underline">블로그 목록으로 →</a></div></main>${FOOTER_HTML}${KAKAO_FLOAT}<script src="/pages.js"></script></body></html>`, 404)
    }

    // 조회수 증가
    await db.prepare('UPDATE blog_posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?').bind(id).run()

    // 이미지
    let images: any[] = []
    try {
      const imgResult = await db.prepare('SELECT id, image_url, COALESCE(r2_key, image_key, \'\') as r2_key, COALESCE(filename, \'\') as filename, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all()
      images = imgResult.results || []
    } catch {
      try { const r2 = await db.prepare('SELECT id, image_url, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all(); images = r2.results || [] } catch {}
    }

    // 도입부 잔재 정리 후 본문 확정 (metaDesc·articleContent 모두 정리된 콘텐츠 기준)
    const cleanContent = sanitizeArticleContent(post.content)
    const plainText = stripHtml(cleanContent)
    const metaDesc = post.meta_description || (plainText.length > 155 ? plainText.substring(0, 155) + '...' : plainText)
    // <title>: '{제목} | 서울가온치과' (PFWE 칼럼 표준 A2)
    const pageTitle = `${post.title} | 서울가온치과`
    const canonicalUrl = `${SITE}/blog/${id}`
    // og:image·스키마 image 는 절대 URL (상대 경로 썸네일 /api/images/... 보정)
    const ogImage = post.thumbnail_url ? (/^https?:\/\//.test(post.thumbnail_url) ? post.thumbnail_url : `${SITE}${post.thumbnail_url.startsWith('/') ? '' : '/'}${post.thumbnail_url}`) : `${SITE}/images/og-blog.jpg`
    const publishDate = fmtDate(post.created_at)
    const modifiedDate = fmtDate(post.updated_at || post.created_at)
    const authorName = post.doctor_name || '서울가온치과'
    const authorTitle = post.doctor_title || '원장'
    const catLabel: Record<string, string> = {'임플란트':'Implant','심미치료':'Aesthetic','신경치료':'Endodontics','치과상식':'Info','일반':'Info'}
    const tag = catLabel[post.category] || post.category || 'Info'

    // 의료진 배지
    let drHtml = ''
    if (post.doctor_name) {
      drHtml = `<a class="bp-doctor" href="/doctors?id=${post.doctor_id}">
        ${post.doctor_photo ? `<img src="${escHtml(post.doctor_photo)}" alt="${escHtml(post.doctor_name)}" width="28" height="28">` : '<i class="fas fa-user-md"></i>'}
        ${escHtml(post.doctor_name)}${post.doctor_title ? ' · ' + escHtml(post.doctor_title) : ''}
      </a>`
    }

    // 콘텐츠 처리
    const isHtmlContent = cleanContent.trim().startsWith('<')
    let articleContent = ''
    if (isHtmlContent) {
      articleContent = cleanContent
    } else {
      articleContent = cleanContent.split('\n').filter((l: string) => l.trim()).map((l: string) => `<p>${escHtml(l)}</p>`).join('\n')
      if (images.length) {
        const cls = images.length === 1 ? 'bp-images single' : 'bp-images'
        articleContent += `<div class="${cls}">${images.map((img: any) => `<img src="${escHtml(img.image_url)}" alt="${escHtml(img.filename || post.title)}" loading="lazy">`).join('')}</div>`
      }
    }

    // 블로그 본문 → 백과사전 용어 자동 크로스링크 (최대 12개)
    try {
      const tr = await db.prepare('SELECT id, term, slug FROM encyclopedia WHERE is_published = 1').all()
      const encTerms = ((tr.results || []) as any[]).filter((t: any) => !ENC_ALIASES[t.slug])
      if (encTerms.length) articleContent = autoCrossLink(articleContent, encTerms, undefined, 12)
    } catch { /* encyclopedia 없어도 블로그는 정상 */ }

    // 날짜 포맷 (한국어)
    const dateObj = new Date(post.created_at)
    const koDate = `${dateObj.getFullYear()}년 ${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일`

    // ── 칼럼 표준(2026-10-03): 이미지 alt/lazy, 핵심 답변, 질문형 H3 FAQ, 관련 진료·글·사례, 작성·감수 박스 ──
    articleContent = seoPolishImgs(articleContent, post.title)
    const answerText = seoAnswerFromHtml(articleContent)
    const faqs = seoFaqsFromHtml(articleContent)
    const txs = seoTxFor(post.category, post.title)
    const authorId = seoDoctorId(post.doctor_id)
    const reviewerId = DOCTOR_HYUN_ID
    let relatedPosts: any[] = [], relatedCases: any[] = []
    try {
      const rp = await db.prepare(`SELECT id, title, content FROM blog_posts WHERE is_published = 1 AND category = ? AND id != ? AND id NOT IN (${BLOG_DUPLICATE_IDS_SQL}) ORDER BY created_at DESC LIMIT 12`).bind(post.category || '', id).all()
      relatedPosts = ((rp.results || []) as any[]).filter((r) => !isThinBlogPost(r)).slice(0, 3)
      const baCat = Object.keys(SEO_CAT_TX).find((k) => txs.some((t) => t.path === SEO_CAT_TX[k]) && k !== '신경치료')
      if (baCat) {
        const rc = await db.prepare('SELECT id, title, category FROM before_after WHERE is_published = 1 AND category = ? ORDER BY created_at DESC LIMIT 3').bind(baCat).all()
        relatedCases = rc.results || []
      }
    } catch { /* 관련 링크 없어도 본문은 정상 */ }
    const drRow: any = post.doctor_id ? { name: post.doctor_name, title: post.doctor_title, role: post.doctor_role, specialties: post.doctor_specialties, education: post.doctor_education } : null
    const reviewed = fmtDate(post.updated_at || post.created_at)
    const authorBoxHtml = `<aside class="sg-author" aria-label="작성·감수">
    <div class="sg-author-ico"><i class="fas fa-user-md"></i></div>
    <div>
      <p class="sg-role">작성·감수</p>
      <p class="sg-name"><a href="/doctors">${escHtml(drRow?.name || '현진호')} ${escHtml(drRow?.title || '대표원장')}</a>${drRow?.role && drRow.role !== drRow.title ? ` · ${escHtml(drRow.role)}` : ''}</p>
      ${drRow?.specialties ? `<p>진료 분야: ${escHtml(String(drRow.specialties))}</p>` : ''}
      ${drRow?.education ? `<p>${escHtml(String(drRow.education).split(/\n/)[0])}</p>` : ''}
      ${reviewed ? `<p>최종 검토일 <time datetime="${reviewed}">${reviewed}</time>${post.doctor_id && String(post.doctor_id) !== '1' ? ' · 감수 현진호 대표원장' : ''}</p>` : ''}
      <p class="sg-note">※ 이 글은 일반적인 건강 정보이며, 진단과 치료 결과는 개인의 구강 상태에 따라 다를 수 있습니다.</p>
    </div>
  </aside>`
    const relatedHtml = (txs.length || relatedPosts.length || relatedCases.length) ? `<nav class="sg-related" aria-label="관련 진료·글">
    ${txs.length ? `<h2>이 글과 관련된 진료</h2><div class="sg-chips">${txs.map((t) => `<a href="${t.path}">${escHtml(t.name)} 진료 안내 →</a>`).join('')}</div>` : ''}
    ${relatedPosts.length ? `<h2>함께 읽으면 좋은 글</h2><ul class="sg-list">${relatedPosts.map((r: any) => `<li><a href="/blog/${r.id}">${escHtml(r.title)}</a></li>`).join('')}</ul>` : ''}
    ${relatedCases.length ? `<h2>관련 비포&amp;애프터</h2><ul class="sg-list">${relatedCases.map((r: any) => `<li><a href="/before-after/${r.id}">${escHtml(r.category || '치과')} 사례 — ${escHtml(r.title)}</a></li>`).join('')}</ul>` : ''}
  </nav>` : ''
    const jsonLdGraph = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "MedicalWebPage",
          "@id": `${canonicalUrl}#webpage`,
          "url": canonicalUrl,
          "name": post.title,
          "description": metaDesc,
          "inLanguage": "ko-KR",
          "isPartOf": { "@id": WEBSITE_ID },
          "breadcrumb": { "@id": `${canonicalUrl}#breadcrumb` },
          "mainEntity": { "@id": `${canonicalUrl}#article` },
          ...(txs.length ? { "about": txs.map((t) => ({ "@id": `${SITE}${t.path}#procedure` })) } : {}),
          "reviewedBy": { "@id": reviewerId },
          ...(reviewed ? { "lastReviewed": reviewed } : {}),
          "speakable": { "@type": "SpeakableSpecification", "cssSelector": answerText ? ["h1", ".sg-answer"] : ["h1"] },
          "publisher": { "@id": CLINIC_ID }
        },
        {
          "@type": "BlogPosting",
          "@id": `${canonicalUrl}#article`,
          "headline": String(post.title).slice(0, 110),
          "description": metaDesc,
          "url": canonicalUrl,
          "image": { "@type": "ImageObject", "url": ogImage },
          ...(publishDate ? { "datePublished": publishDate } : {}),
          ...(modifiedDate ? { "dateModified": modifiedDate } : {}),
          "author": post.doctor_id ? { "@id": authorId } : { "@id": CLINIC_ID },
          "publisher": { "@id": CLINIC_ID },
          "mainEntityOfPage": { "@id": `${canonicalUrl}#webpage` },
          "isPartOf": { "@id": WEBSITE_ID },
          ...(txs.length ? { "about": txs.map((t) => ({ "@id": `${SITE}${t.path}#procedure` })) } : {}),
          "inLanguage": "ko-KR",
          "articleSection": post.category || "치과 건강정보",
          "wordCount": plainText.split(/\s+/).length
        },
        {
          "@type": "BreadcrumbList",
          "@id": `${canonicalUrl}#breadcrumb`,
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "홈", "item": `${SITE}/` },
            { "@type": "ListItem", "position": 2, "name": "블로그", "item": `${SITE}/blog` },
            ...(post.category ? [{ "@type": "ListItem", "position": 3, "name": post.category, "item": `${SITE}/blog?category=${encodeURIComponent(post.category)}` }] : []),
            { "@type": "ListItem", "position": post.category ? 4 : 3, "name": post.title, "item": canonicalUrl }
          ]
        },
        ...(faqs.length >= 2 ? [{
          "@type": "FAQPage",
          "@id": `${canonicalUrl}#faq`,
          "isPartOf": { "@id": `${canonicalUrl}#webpage` },
          "mainEntity": faqs.map((f) => ({ "@type": "Question", "name": f.q, "acceptedAnswer": { "@type": "Answer", "text": f.a } }))
        }] : [])
      ]
    }

    // (병원 Dentist 전체 정의는 홈 /#clinic 하나로 통일 — 글마다 붙던 @id 없는 중복 Dentist 제거)

    // 본문 600자 미만 얇은 글은 noindex, follow (사이트맵에서도 제외 — 내용 보강 후 자동 복귀)
    const thinPost = isThinBlogPost(post)
    const robotsDirective = thinPost ? 'noindex, follow' : 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1'

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>${escHtml(pageTitle)}</title>
<meta name="description" content="${escHtml(metaDesc)}">
<meta name="robots" content="${robotsDirective}">
<meta name="author" content="${escHtml(authorName)}">
<link rel="canonical" href="${canonicalUrl}">
<link rel="alternate" hreflang="ko" href="${canonicalUrl}">
<!-- Open Graph -->
<meta property="og:type" content="article">
<meta property="og:site_name" content="서울가온치과">
<meta property="og:title" content="${escHtml(pageTitle)}">
<meta property="og:description" content="${escHtml(metaDesc)}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:image" content="${escHtml(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="ko_KR">
<meta property="article:published_time" content="${publishDate}">
<meta property="article:modified_time" content="${modifiedDate}">
<meta property="article:author" content="${escHtml(authorName)}">
<meta property="article:section" content="${escHtml(post.category || '치과')}">
<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(pageTitle)}">
<meta name="twitter:description" content="${escHtml(metaDesc)}">
<meta name="twitter:image" content="${escHtml(ogImage)}">
<!-- JSON-LD Structured Data -->
<script type="application/ld+json">${seoLd(jsonLdGraph)}</script>
<style>
${SEO_BOX_CSS}
.bp-wrap{max-width:800px;margin:0 auto;padding:clamp(8rem,15vh,12rem) clamp(1.5rem,4vw,3rem) clamp(4rem,8vh,6rem)}
.bp-back{display:inline-flex;align-items:center;gap:.4rem;font-size:.82rem;color:var(--stone-l,#AFA79D);margin-bottom:2rem;transition:color .3s;text-decoration:none}
.bp-back:hover{color:var(--gold,#BFA46A)}
.bp-back i{font-size:.7rem;transition:transform .3s}
.bp-back:hover i{transform:translateX(-3px)}
.bp-meta{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
.bp-tag{font-family:var(--ff-en,'Bebas Neue');font-size:.72rem;letter-spacing:3px;text-transform:uppercase;color:var(--gold,#BFA46A);padding:.3rem .8rem;border:1px solid rgba(191,164,106,.2);border-radius:100px}
.bp-date{font-size:.78rem;color:var(--stone,#8C8578)}
.bp-title{font-family:var(--ff-title);font-weight:500;font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.4;margin-bottom:1.5rem;color:var(--ivory,#F2EDE4)}
.bp-doctor{display:inline-flex;align-items:center;gap:.5rem;padding:.5rem 1rem;background:rgba(191,164,106,.08);border:1px solid rgba(191,164,106,.15);border-radius:100px;font-size:.82rem;color:var(--stone-l,#AFA79D);text-decoration:none;transition:all .3s;margin-bottom:2.5rem}
.bp-doctor:hover{border-color:var(--gold,#BFA46A);color:var(--gold,#BFA46A)}
.bp-doctor img{width:28px;height:28px;border-radius:50%;object-fit:cover}
.bp-divider{width:60px;height:1px;background:linear-gradient(90deg,var(--gold,#BFA46A),transparent);margin-bottom:2.5rem}
.bp-content{font-size:clamp(.9rem,1vw,.98rem);line-height:2;color:var(--stone-l,#AFA79D);word-break:keep-all;margin-bottom:3rem}
.bp-content h2{font-family:var(--ff-title);font-weight:500;font-size:clamp(1.25rem,2.5vw,1.6rem);color:var(--ivory,#F2EDE4);margin:2.5rem 0 1rem;padding-bottom:.5rem;border-bottom:1px solid rgba(191,164,106,.12);line-height:1.4}
.bp-content h3{font-size:clamp(1.05rem,2vw,1.2rem);color:var(--ivory,#F2EDE4);margin:2rem 0 .8rem;font-weight:600;line-height:1.4}
.bp-content p{margin-bottom:1.2rem;line-height:2}
.bp-content strong,.bp-content b{color:var(--ivory,#F2EDE4);font-weight:600}
.bp-content a{color:var(--gold,#BFA46A);text-decoration:underline;text-underline-offset:3px}
.bp-content ul,.bp-content ol{margin:1rem 0 1.5rem 1.2rem;line-height:1.9}
.bp-content li{margin-bottom:.4rem}
.bp-content li::marker{color:var(--gold,#BFA46A)}
.bp-content blockquote{border-left:3px solid var(--gold,#BFA46A);padding:.8rem 1.5rem;margin:1.5rem 0;font-style:italic;color:#bbb;background:rgba(191,164,106,.04);border-radius:0 8px 8px 0}
.bp-content figure{margin:2rem 0;text-align:center}
.bp-content figure img{max-width:100%;border-radius:12px;border:1px solid rgba(191,164,106,.08)}
.bp-content figcaption{font-size:.78rem;color:var(--stone,#8C8578);margin-top:.6rem;font-style:italic}
.enc-xlink{color:var(--gold);text-decoration:none;border-bottom:1px dotted rgba(191,164,106,.5)}
.enc-xlink:hover{border-bottom-style:solid}
.bp-images{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;margin-bottom:3rem}
.bp-images img{width:100%;border-radius:12px;aspect-ratio:4/3;object-fit:cover;border:1px solid rgba(191,164,106,.08)}
.bp-images.single{grid-template-columns:1fr}
.bp-images.single img{aspect-ratio:auto;max-height:500px;object-fit:contain;background:var(--ink-3,#111009)}
.bp-bottom{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding-top:2rem;border-top:1px solid var(--line,rgba(191,164,106,.1));flex-wrap:wrap}
.bp-btn{display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.5rem;border-radius:100px;font-size:.82rem;font-weight:500;text-decoration:none;transition:all .3s}
.bp-btn-back{border:1px solid var(--line,rgba(191,164,106,.1));color:var(--stone-l,#AFA79D)}
.bp-btn-back:hover{border-color:var(--gold,#BFA46A);color:var(--gold,#BFA46A)}
.bp-btn-cta{background:var(--gold,#BFA46A);color:var(--ink,#050504);font-weight:600}
.bp-btn-cta:hover{background:var(--gold-b,#D4BA82)}
.lb{position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:10000;display:none;align-items:center;justify-content:center;cursor:zoom-out}
.lb.show{display:flex}
.lb img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px}
@media(max-width:768px){
  .bp-wrap{padding:6.5rem 1.25rem 3rem}
  .bp-title{font-size:clamp(1.3rem,5.5vw,1.8rem)}
  .bp-content{font-size:.88rem;line-height:1.85}
  .bp-content h2{font-size:1.2rem;margin:2rem 0 .8rem}
  .bp-images{grid-template-columns:1fr}
  .bp-bottom{flex-direction:column;align-items:stretch;gap:.75rem}
  .bp-btn{justify-content:center;padding:.7rem 1.25rem;min-height:44px}
}
</style>
</head>
<body>
<noscript><div style="background:#BFA46A;color:#050504;padding:1rem;text-align:center;font-weight:600">이 웹사이트는 JavaScript가 필요합니다.</div></noscript>
${NAV_HTML}
<main id="main-content" role="main">
<div class="bp-wrap">
  <a href="/blog" class="bp-back"><i class="fas fa-chevron-left"></i> 블로그 목록으로</a>
  <div class="bp-meta">
    <span class="bp-tag">${escHtml(tag)}</span>
    <time class="bp-date" datetime="${publishDate}">${koDate}</time>
  </div>
  <h1 class="bp-title">${escHtml(post.title)}</h1>
  ${drHtml}
  <div class="bp-divider"></div>
  ${answerText ? `<div class="sg-answer" id="blog-answer"><p class="sg-answer-label">핵심 답변</p>${escHtml(answerText)}</div>` : ''}
  <article class="bp-content" itemprop="articleBody">${articleContent}</article>
  ${authorBoxHtml}
  ${relatedHtml}
  <div class="bp-bottom">
    <a href="/blog" class="bp-btn bp-btn-back"><i class="fas fa-arrow-left"></i> 목록으로</a>
    <a href="tel:0507-1325-3377" class="bp-btn bp-btn-cta"><i class="fas fa-phone"></i> 상담 예약</a>
  </div>
</div>
</main>
${FOOTER_HTML}
<div class="lb" id="lb" onclick="this.classList.remove('show')"><img id="lb-img" src="" alt=""></div>
${KAKAO_FLOAT}
<script src="/pages.js"></script>
<script>
// Lightbox + Nav (hydration)
document.querySelectorAll('.bp-content figure img, .bp-content img, .bp-images img').forEach(function(img){
  img.style.cursor='pointer';
  img.addEventListener('click',function(){document.getElementById('lb-img').src=img.src;document.getElementById('lb').classList.add('show')});
});
document.addEventListener('keydown',function(e){if(e.key==='Escape')document.getElementById('lb').classList.remove('show')});
var ham=document.querySelector('.hamburger'),mob=document.querySelector('.mob-menu');
if(ham&&mob){ham.addEventListener('click',function(){ham.classList.toggle('open');mob.classList.toggle('open')});mob.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){ham.classList.remove('open');mob.classList.remove('open')})})}
</script>
</body>
</html>`

    return c.html(html, 200, {
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200',
      'X-Robots-Tag': robotsDirective,
    })
  } catch (e: any) {
    console.error('[SSR BLOG ERROR]', e.message)
    return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>오류 | 서울가온치과</title></head><body><p>잠시 후 다시 시도해주세요.</p></body></html>`, 500)
  }
})

// ══════════════════════════════════════════════════
//  SSR — 비포&애프터 상세 (Server-Side Rendering for SEO/AEO)
// ══════════════════════════════════════════════════
app.get('/before-after/:id', async (c) => {
  try {
    const db = c.env.DB
    await initDB(db)
    const id = c.req.param('id')
    const item: any = await db.prepare(
      `SELECT ba.*, d.name as doctor_name, d.photo_url as doctor_photo, d.title as doctor_title
       FROM before_after ba LEFT JOIN doctors d ON ba.doctor_id = d.id
       WHERE ba.id = ? AND ba.is_published = 1`
    ).bind(id).first()

    if (!item) {
      return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>케이스를 찾을 수 없습니다 | 서울가온치과</title>${HEAD_COMMON}</head><body>${NAV_HTML}<main style="min-height:60vh;display:flex;align-items:center;justify-content:center;text-align:center;padding-top:72px"><div><h1 style="color:var(--gold);font-size:2rem;margin-bottom:1rem">404</h1><p style="color:var(--stone-l);margin-bottom:2rem">케이스를 찾을 수 없습니다.</p><a href="/before-after" style="color:var(--gold);text-decoration:underline">비포 애프터 목록으로 →</a></div></main>${FOOTER_HTML}${KAKAO_FLOAT}<script src="/pages.js"></script></body></html>`, 404)
    }

    // 조회수 증가
    await db.prepare('UPDATE before_after SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?').bind(id).run()

    // 사례 제목 규칙: {진료명} 사례 — {내용} (치료 기간 필드는 DB 에 없음, 환자 식별정보 없음)
    const caseHeadline = `${item.category || '치과 치료'} 사례 — ${item.title}`
    const pageTitle = `${caseHeadline} | 서울가온치과`
    const metaDesc = item.description
      ? (item.description.length > 155 ? item.description.substring(0, 155) + '...' : item.description)
      : `${item.title} - 서울가온치과 ${item.category || '치과'} 치료 전후 비교 사진. 의정부 임플란트·심미치료 중점 진료.`
    const canonicalUrl = `${SITE}/before-after/${id}`
    const absU = (u: string) => (/^https?:\/\//.test(u) ? u : `${SITE}${u.startsWith('/') ? '' : '/'}${u}`)
    const ogImage = absU(item.intraoral_after_url || item.intraoral_before_url || `${SITE}/images/og-main.jpg`)
    const publishDate = fmtDate(item.created_at)
    const modifiedDate = fmtDate(item.updated_at || item.created_at)
    const authorName = item.doctor_name || '서울가온치과'
    const authorTitle = item.doctor_title || '원장'
    const catLabel: Record<string, string> = {'임플란트':'Implant','심미치료':'Aesthetic','신경치료':'Endodontics','치과상식':'Info','일반':'Info'}
    const tag = catLabel[item.category] || item.category || 'Case'

    // 의료진 배지
    let drHtml = ''
    if (item.doctor_name) {
      drHtml = `<a class="bp-doctor" href="/doctors?id=${item.doctor_id}">
        ${item.doctor_photo ? `<img src="${escHtml(item.doctor_photo)}" alt="${escHtml(item.doctor_name)}" width="28" height="28">` : '<i class="fas fa-user-md"></i>'}
        ${escHtml(item.doctor_name)}${item.doctor_title ? ' · ' + escHtml(item.doctor_title) : ''}
      </a>`
    }

    const dateObj = new Date(item.created_at)
    const koDate = `${dateObj.getFullYear()}년 ${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일`

    // 이미지 섹션 구성
    let imagesHtml = ''
    if (item.intraoral_before_url || item.intraoral_after_url) {
      imagesHtml += `<section class="ba-compare"><h2><i class="fas fa-teeth"></i> 구강 내 사진</h2><div class="ba-pair">`
      if (item.intraoral_before_url) imagesHtml += `<figure><img src="${escHtml(item.intraoral_before_url)}" alt="${escHtml(item.category || '치과')} 치료 전 — 구강 내 사진" loading="lazy" width="600" height="400"><figcaption>Before</figcaption></figure>`
      if (item.intraoral_after_url) imagesHtml += `<figure><img src="${escHtml(item.intraoral_after_url)}" alt="${escHtml(item.category || '치과')} 치료 후 — 구강 내 사진" loading="lazy" width="600" height="400"><figcaption>After</figcaption></figure>`
      imagesHtml += `</div></section>`
    }
    if (item.panorama_before_url || item.panorama_after_url) {
      imagesHtml += `<section class="ba-compare"><h2><i class="fas fa-x-ray"></i> 파노라마 사진</h2><div class="ba-pair">`
      if (item.panorama_before_url) imagesHtml += `<figure><img src="${escHtml(item.panorama_before_url)}" alt="${escHtml(item.category || '치과')} 치료 전 — 파노라마" loading="lazy" width="600" height="300"><figcaption>Before</figcaption></figure>`
      if (item.panorama_after_url) imagesHtml += `<figure><img src="${escHtml(item.panorama_after_url)}" alt="${escHtml(item.category || '치과')} 치료 후 — 파노라마" loading="lazy" width="600" height="300"><figcaption>After</figcaption></figure>`
      imagesHtml += `</div></section>`
    }

    // ── 사례 표준(2026-10-03): 구조 필드 요약·관련 진료/칼럼/사례·@graph(MedicalWebPage+Breadcrumb), Review/Rating 없음 ──
    const txs = seoTxFor(item.category, item.title)
    const reviewed = fmtDate(item.updated_at || item.created_at)
    const shots: string[] = []
    if (item.intraoral_before_url || item.intraoral_after_url) shots.push('구강 내 사진')
    if (item.panorama_before_url || item.panorama_after_url) shots.push('파노라마')
    const summaryRows: [string, string][] = [['진료', item.category || '치과 치료'], ['치료 내용', item.title]]
    if (shots.length) summaryRows.push(['기록 자료', `${shots.join('·')} (치료 전·후)`])
    if (item.doctor_name) summaryRows.push(['담당 원장', `${item.doctor_name}${item.doctor_title ? ' ' + item.doctor_title : ''}`])
    const summaryHtml = `<div class="sg-answer" id="case-summary"><p class="sg-answer-label">사례 요약</p><dl>${summaryRows.map(([k, v]) => `<dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd>`).join('')}</dl></div>`
    let relPosts: any[] = [], sameCases: any[] = []
    try {
      if (item.category) {
        const rp = await db.prepare(`SELECT id, title, content FROM blog_posts WHERE is_published = 1 AND category = ? AND id NOT IN (${BLOG_DUPLICATE_IDS_SQL}) ORDER BY created_at DESC LIMIT 12`).bind(item.category).all()
        relPosts = ((rp.results || []) as any[]).filter((r) => !isThinBlogPost(r)).slice(0, 3)
        const rc = await db.prepare('SELECT id, title, category FROM before_after WHERE is_published = 1 AND category = ? AND id != ? ORDER BY created_at DESC LIMIT 3').bind(item.category, id).all()
        sameCases = rc.results || []
      }
    } catch { /* 관련 링크 없어도 본문 정상 */ }
    const caseLinksHtml = `<nav class="sg-related" aria-label="관련 진료·칼럼·사례">
    ${txs.length ? `<h2>관련 진료</h2><div class="sg-chips">${txs.map((t) => `<a href="${t.path}">${escHtml(t.name)} 진료 안내 →</a>`).join('')}</div>` : ''}
    ${relPosts.length ? `<h2>관련 칼럼</h2><ul class="sg-list">${relPosts.map((r: any) => `<li><a href="/blog/${r.id}">${escHtml(r.title)}</a></li>`).join('')}</ul>` : ''}
    ${sameCases.length ? `<h2>같은 진료의 다른 사례</h2><ul class="sg-list">${sameCases.map((r: any) => `<li><a href="/before-after/${r.id}">${escHtml(r.category || '치과')} 사례 — ${escHtml(r.title)}</a></li>`).join('')}</ul>` : ''}
  </nav>`
    const galleryImages: any[] = []
    if (item.intraoral_before_url) galleryImages.push({ "@type": "ImageObject", "url": absU(item.intraoral_before_url), "caption": `${item.category || '치과'} 치료 전 — 구강 내 사진` })
    if (item.intraoral_after_url) galleryImages.push({ "@type": "ImageObject", "url": absU(item.intraoral_after_url), "caption": `${item.category || '치과'} 치료 후 — 구강 내 사진` })
    if (item.panorama_before_url) galleryImages.push({ "@type": "ImageObject", "url": absU(item.panorama_before_url), "caption": `${item.category || '치과'} 치료 전 — 파노라마` })
    if (item.panorama_after_url) galleryImages.push({ "@type": "ImageObject", "url": absU(item.panorama_after_url), "caption": `${item.category || '치과'} 치료 후 — 파노라마` })
    const jsonLdGraph = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "MedicalWebPage",
          "@id": `${canonicalUrl}#webpage`,
          "url": canonicalUrl,
          "name": caseHeadline,
          "description": metaDesc,
          "inLanguage": "ko-KR",
          "isPartOf": { "@id": WEBSITE_ID },
          "breadcrumb": { "@id": `${canonicalUrl}#breadcrumb` },
          ...(txs.length ? { "about": { "@id": `${SITE}${txs[0].path}#procedure` } } : {}),
          "reviewedBy": { "@id": seoDoctorId(item.doctor_id) },
          ...(reviewed ? { "lastReviewed": reviewed } : {}),
          ...(publishDate ? { "datePublished": publishDate } : {}),
          ...(modifiedDate ? { "dateModified": modifiedDate } : {}),
          ...(galleryImages.length ? { "image": galleryImages } : {}),
          "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["h1", "#case-summary"] },
          "publisher": { "@id": CLINIC_ID }
        },
        {
          "@type": "BreadcrumbList",
          "@id": `${canonicalUrl}#breadcrumb`,
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "홈", "item": `${SITE}/` },
            { "@type": "ListItem", "position": 2, "name": "비포 애프터", "item": `${SITE}/before-after` },
            ...(item.category ? [{ "@type": "ListItem", "position": 3, "name": item.category, "item": `${SITE}/before-after?category=${encodeURIComponent(item.category)}` }] : []),
            { "@type": "ListItem", "position": item.category ? 4 : 3, "name": caseHeadline, "item": canonicalUrl }
          ]
        }
      ]
    }

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>${escHtml(pageTitle)}</title>
<meta name="description" content="${escHtml(metaDesc)}">
<meta name="robots" content="noindex, follow">
<meta name="author" content="${escHtml(authorName)}">
<link rel="canonical" href="${canonicalUrl}">
<link rel="alternate" hreflang="ko" href="${canonicalUrl}">
<!-- Open Graph -->
<meta property="og:type" content="article">
<meta property="og:site_name" content="서울가온치과">
<meta property="og:title" content="${escHtml(pageTitle)}">
<meta property="og:description" content="${escHtml(metaDesc)}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:image" content="${escHtml(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="ko_KR">
<meta property="article:published_time" content="${publishDate}">
<meta property="article:modified_time" content="${modifiedDate}">
<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(pageTitle)}">
<meta name="twitter:description" content="${escHtml(metaDesc)}">
<meta name="twitter:image" content="${escHtml(ogImage)}">
<!-- JSON-LD Structured Data -->
<script type="application/ld+json">${seoLd(jsonLdGraph)}</script>
<style>
${SEO_BOX_CSS}
.ba-detail-wrap{max-width:800px;margin:0 auto;padding:clamp(8rem,15vh,12rem) clamp(1.5rem,4vw,3rem) clamp(4rem,8vh,6rem)}
.bp-back{display:inline-flex;align-items:center;gap:.4rem;font-size:.82rem;color:var(--stone-l,#AFA79D);margin-bottom:2rem;transition:color .3s;text-decoration:none}
.bp-back:hover{color:var(--gold,#BFA46A)}
.bp-back i{font-size:.7rem;transition:transform .3s}
.bp-back:hover i{transform:translateX(-3px)}
.bp-meta{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
.bp-tag{font-family:var(--ff-en,'Bebas Neue');font-size:.72rem;letter-spacing:3px;text-transform:uppercase;color:var(--gold,#BFA46A);padding:.3rem .8rem;border:1px solid rgba(191,164,106,.2);border-radius:100px}
.bp-date{font-size:.78rem;color:var(--stone,#8C8578)}
.ba-detail-title{font-family:var(--ff-title);font-weight:500;font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.4;margin-bottom:1.5rem;color:var(--ivory,#F2EDE4)}
.bp-doctor{display:inline-flex;align-items:center;gap:.5rem;padding:.5rem 1rem;background:rgba(191,164,106,.08);border:1px solid rgba(191,164,106,.15);border-radius:100px;font-size:.82rem;color:var(--stone-l,#AFA79D);text-decoration:none;transition:all .3s;margin-bottom:1.5rem}
.bp-doctor:hover{border-color:var(--gold,#BFA46A);color:var(--gold,#BFA46A)}
.bp-doctor img{width:28px;height:28px;border-radius:50%;object-fit:cover}
.ba-desc{font-size:clamp(.9rem,1vw,.98rem);line-height:2;color:var(--stone-l,#AFA79D);word-break:keep-all;margin-bottom:2.5rem}
.ba-compare{margin-bottom:3rem}
.ba-compare h2{font-family:var(--ff-title);font-weight:500;font-size:1.1rem;color:var(--ivory,#F2EDE4);margin-bottom:1.2rem;display:flex;align-items:center;gap:.5rem}
.ba-compare h2 i{color:var(--gold,#BFA46A);font-size:.9rem}
.ba-pair{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.ba-pair figure{text-align:center}
.ba-pair img{width:100%;border-radius:12px;border:1px solid rgba(191,164,106,.08);cursor:pointer;transition:transform .3s,box-shadow .3s}
.ba-pair img:hover{transform:scale(1.02);box-shadow:0 8px 30px rgba(0,0,0,.3)}
.ba-pair figcaption{font-size:.75rem;color:var(--stone,#8C8578);margin-top:.5rem;font-weight:600;letter-spacing:2px;text-transform:uppercase}
.bp-bottom{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding-top:2rem;border-top:1px solid var(--line,rgba(191,164,106,.1));flex-wrap:wrap}
.bp-btn{display:inline-flex;align-items:center;gap:.4rem;padding:.6rem 1.5rem;border-radius:100px;font-size:.82rem;font-weight:500;text-decoration:none;transition:all .3s}
.bp-btn-back{border:1px solid var(--line,rgba(191,164,106,.1));color:var(--stone-l,#AFA79D)}
.bp-btn-back:hover{border-color:var(--gold,#BFA46A);color:var(--gold,#BFA46A)}
.bp-btn-cta{background:var(--gold,#BFA46A);color:var(--ink,#050504);font-weight:600}
.bp-btn-cta:hover{background:var(--gold-b,#D4BA82)}
.lb{position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:10000;display:none;align-items:center;justify-content:center;cursor:zoom-out}
.lb.show{display:flex}
.lb img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px}
@media(max-width:768px){
  .ba-detail-wrap{padding:6.5rem 1.25rem 3rem}
  .ba-detail-title{font-size:clamp(1.3rem,5.5vw,1.8rem)}
  .ba-pair{grid-template-columns:1fr}
  .bp-bottom{flex-direction:column;align-items:stretch;gap:.75rem}
  .bp-btn{justify-content:center;padding:.7rem 1.25rem;min-height:44px}
}
</style>
</head>
<body>
<noscript><div style="background:#BFA46A;color:#050504;padding:1rem;text-align:center;font-weight:600">이 웹사이트는 JavaScript가 필요합니다.</div></noscript>
${NAV_HTML}
<main id="main-content" role="main">
<div class="ba-detail-wrap">
  <a href="/before-after" class="bp-back"><i class="fas fa-chevron-left"></i> 비포 애프터 목록으로</a>
  <div class="bp-meta">
    <span class="bp-tag">${escHtml(tag)}</span>
    <time class="bp-date" datetime="${publishDate}">${koDate}</time>
  </div>
  <h1 class="ba-detail-title">${escHtml(caseHeadline)}</h1>
  ${drHtml}
  ${summaryHtml}
  ${item.description ? `<p class="ba-desc">${escHtml(item.description)}</p>` : ''}
  ${imagesHtml}
  <p style="font-size:.78rem;color:var(--stone,#8C8578);line-height:1.7;margin:0 0 2rem">※ 치료 전·후 사진은 같은 촬영 조건에서 기록했으며, 치료 결과는 개인의 구강 상태에 따라 다를 수 있습니다.${reviewed ? ` 최종 검토: ${reviewed}` : ''}</p>
  ${caseLinksHtml}
  <div class="bp-bottom">
    <a href="/before-after" class="bp-btn bp-btn-back"><i class="fas fa-arrow-left"></i> 목록으로</a>
    <a href="tel:0507-1325-3377" class="bp-btn bp-btn-cta"><i class="fas fa-phone"></i> 상담 예약</a>
  </div>
</div>
</main>
${FOOTER_HTML}
<div class="lb" id="lb" onclick="this.classList.remove('show')"><img id="lb-img" src="" alt=""></div>
${KAKAO_FLOAT}
<script src="/pages.js"></script>
<script>
document.querySelectorAll('.ba-pair img').forEach(function(img){
  img.addEventListener('click',function(){document.getElementById('lb-img').src=img.src;document.getElementById('lb').classList.add('show')});
});
document.addEventListener('keydown',function(e){if(e.key==='Escape')document.getElementById('lb').classList.remove('show')});
var ham=document.querySelector('.hamburger'),mob=document.querySelector('.mob-menu');
if(ham&&mob){ham.addEventListener('click',function(){ham.classList.toggle('open');mob.classList.toggle('open')});mob.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){ham.classList.remove('open');mob.classList.remove('open')})})}
</script>
</body>
</html>`

    return c.html(html, 200, {
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200',
      // 2026-09-21: 사진은 로그인 후 열람 → 크롤러에겐 얇은 페이지(GSC Soft 404). 목록(/before-after)만 색인.
      'X-Robots-Tag': 'noindex, follow',
    })
  } catch (e: any) {
    console.error('[SSR BA ERROR]', e.message)
    return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>오류 | 서울가온치과</title></head><body><p>잠시 후 다시 시도해주세요.</p></body></html>`, 500)
  }
})

// ══════════════════════════════════════════════════
//  SSR — 치과 백과사전 (283+ 용어 → 개별 SEO/AEO 페이지)
// ══════════════════════════════════════════════════

// slug가 URL-safe한지 검사 (한글/영문/숫자/하이픈만)
function encSlugClean(slug: string): boolean {
  return /^[가-힣a-zA-Z0-9-]+$/.test(slug)
}
// 용어의 canonical 경로: 깨끗한 slug면 slug, 아니면 id
function encPath(e: { id: number; slug: string }): string {
  return encSlugClean(e.slug) ? `/encyclopedia/${encodeURIComponent(e.slug)}` : `/encyclopedia/${e.id}`
}
// 마크다운-ish 콘텐츠 → HTML (서버사이드, 리스트 wrapping 포함)
function encFormatContent(text: string): string {
  if (!text) return ''
  if (/<[a-z][\s\S]*>/i.test(text)) return text
  const lines = text.split('\n')
  let html = ''
  let inList = false
  for (let raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('- ')) {
      if (!inList) { html += '<ul>'; inList = true }
      html += `<li>${escHtml(line.slice(2))}</li>`
    } else {
      if (inList) { html += '</ul>'; inList = false }
      if (line.startsWith('## ')) html += `<h2>${escHtml(line.slice(3))}</h2>`
      else if (line.startsWith('### ')) html += `<h3>${escHtml(line.slice(4))}</h3>`
      else html += `<p>${escHtml(line)}</p>`
    }
  }
  if (inList) html += '</ul>'
  return html
}

// DB 본문 앞에 섞여 들어간 작성 도구 대화문 제거 (2026-10-08 발견: 레진 수복 본문이 "맞습니다! 바로 수정합니다…"로 시작)
// 원격 DB 는 고치지 않고 렌더 시 지정한 소제목부터 보여 준다.
const ENC_CONTENT_START: Record<string, string> = { 'composite-resin-restoration': '## 레진 수복이란?' }
function encCleanContent(slug: string, content: string): string {
  const marker = ENC_CONTENT_START[slug]
  if (!marker || !content) return content || ''
  const i = content.indexOf(marker)
  return i > 0 ? content.slice(i) : content
}

const ENC_CAT_ORDER = ['임플란트','보철','보존','교정','예방','구강외과','심미','소아·청소년','진단·검사','잇몸','일반']

// ── 자동 크로스링크 엔진 ──
// HTML 본문의 텍스트 노드에서 백과사전 용어를 찾아 첫 등장 1회만 링크로 치환.
// 긴 용어 우선 매칭("가이드 임플란트" > "임플란트"), 자기 자신 제외, 페이지당 최대 20개.
function autoCrossLink(html: string, terms: Array<{ id: number; term: string; slug: string }>, selfId?: number, maxLinks = 20): string {
  if (!html || !terms.length) return html
  // 2글자 이상 용어만, 길이 내림차순
  const candidates = terms
    .filter(t => t.id !== selfId && t.term && t.term.length >= 2 && /^[가-힣a-zA-Z0-9 ·-]+$/.test(t.term))
    .sort((a, b) => b.term.length - a.term.length)
  if (!candidates.length) return html

  const linked = new Set<number>()
  let linkCount = 0

  // HTML을 태그/텍스트로 분할 — a 태그와 heading 내부는 건드리지 않음
  const parts = html.split(/(<[^>]+>)/g)
  let skipDepth = 0  // <a>, <h1-h6>, <script>, <style> 내부 스킵
  const skipOpen = /^<(a|h[1-6]|script|style|summary)[\s>]/i
  const skipClose = /^<\/(a|h[1-6]|script|style|summary)>/i

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.startsWith('<')) {
      if (skipOpen.test(part)) skipDepth++
      else if (skipClose.test(part)) skipDepth = Math.max(0, skipDepth - 1)
      continue
    }
    if (skipDepth > 0 || !part.trim() || linkCount >= maxLinks) continue

    // 1) 원본 텍스트에서 매칭 위치 수집 (겹침 방지) — 치환은 마지막에 한 번에
    const text = part
    const matches: Array<{ start: number; end: number; t: { id: number; term: string; slug: string } }> = []
    const taken: Array<[number, number]> = []
    for (const t of candidates) {
      if (linked.has(t.id) || linkCount + matches.length >= maxLinks) continue
      let from = 0
      while (from < text.length) {
        const idx = text.indexOf(t.term, from)
        if (idx === -1) break
        const end = idx + t.term.length
        const before = idx > 0 ? text[idx - 1] : ''
        const after = end < text.length ? text[end] : ''
        const wordBoundaryOk = !/[가-힣a-zA-Z]/.test(before) && !/[가-힣a-zA-Z]/.test(after)
        const overlaps = taken.some(([s, e]) => idx < e && end > s)
        if (wordBoundaryOk && !overlaps) {
          matches.push({ start: idx, end, t })
          taken.push([idx, end])
          linked.add(t.id)
          break  // 용어당 첫 등장 1회만
        }
        from = idx + 1
      }
    }
    if (!matches.length) continue
    // 2) 뒤에서부터 치환 (인덱스 안정성)
    matches.sort((a, b) => b.start - a.start)
    let out = text
    for (const m of matches) {
      const href = encSlugClean(m.t.slug) ? `/encyclopedia/${encodeURIComponent(m.t.slug)}` : `/encyclopedia/${m.t.id}`
      out = out.slice(0, m.start) + `<a href="${href}" class="enc-xlink" title="${escHtml(m.t.term)} — 치과 백과사전">${m.t.term}</a>` + out.slice(m.end)
      linkCount++
    }
    parts[i] = out
  }
  return parts.join('')
}

const ENC_XLINK_CSS = `.enc-xlink{color:var(--gold);text-decoration:none;border-bottom:1px dotted rgba(191,164,106,.5)}
.enc-xlink:hover{border-bottom-style:solid}`

// ── 301: 구 URL → 클린 URL ──
app.get('/encyclopedia.html', (c) => {
  const term = c.req.query('term')
  if (term) return c.redirect(`/encyclopedia/${encodeURIComponent(term)}`, 301)
  return c.redirect('/encyclopedia', 301)
})

// ── SSR: 백과사전 목록 (283개 용어 전체 내부링크 — 크롤러 완전 노출) ──
app.get('/encyclopedia', async (c) => {
  try {
    // 구 쿼리스트링 (?term=slug) → 상세페이지 301
    const term = c.req.query('term')
    if (term) return c.redirect(`/encyclopedia/${encodeURIComponent(term)}`, 301)

    const db = c.env.DB
    await initDB(db)
    const result = await db.prepare(
      `SELECT id, term, slug, category, summary FROM encyclopedia WHERE is_published = 1 ORDER BY sort_order ASC, term ASC`
    ).all()
    const entries: any[] = (result.results || []).filter((e: any) => !ENC_ALIASES[e.slug])
    const total = entries.length

    // 카테고리별 그룹핑 (동의어 301 대상은 목록에서 제외)
    const byCat: Record<string, any[]> = {}
    for (const e of entries) {
      if (ENC_ALIASES[e.slug]) continue
      const cat = e.category || '일반'
      if (!byCat[cat]) byCat[cat] = []
      byCat[cat].push(e)
    }
    const cats = Object.keys(byCat).sort((a, b) => {
      const ia = ENC_CAT_ORDER.indexOf(a), ib = ENC_CAT_ORDER.indexOf(b)
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    })

    // 카테고리 탭 + 섹션 HTML
    const tabsHtml = cats.map(cat => `<a href="#cat-${encodeURIComponent(cat)}" class="enc-tab">${escHtml(cat)} <span>${byCat[cat].length}</span></a>`).join('')
    const sectionsHtml = cats.map(cat => `
    <section id="cat-${escHtml(cat)}" class="enc-section">
      <h2><i class="fas fa-folder-open" style="color:var(--gold);margin-right:.5rem"></i>${escHtml(cat)} <span class="enc-count">(${byCat[cat].length}개 용어)</span></h2>
      <div class="enc-grid">
        ${byCat[cat].map((e: any) => `<a href="${encPath(e)}" class="enc-item" data-term="${escHtml(e.term.toLowerCase())} ${escHtml((e.summary || '').toLowerCase())}">
          <strong>${escHtml(e.term)}</strong>
          <span>${escHtml((e.summary || '').substring(0, 80))}${(e.summary || '').length > 80 ? '…' : ''}</span>
        </a>`).join('')}
      </div>
    </section>`).join('')

    // JSON-LD: CollectionPage + DefinedTermSet
    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          "name": "치과 백과사전 — 서울가온치과",
          "description": `치과 용어 ${total}개를 쉬운 말로 풀어 정리한 치과 백과사전(일반 건강정보). 임플란트, 보철, 신경치료, 교정, 잇몸 등 카테고리별 정리.`,
          "url": `${SITE}/encyclopedia`,
          "isPartOf": WEBSITE_REF,
          "numberOfItems": total,
          "publisher": CLINIC_REF
        },
        {
          "@type": "DefinedTermSet",
          "@id": `${SITE}/encyclopedia#termset`,
          "name": "서울가온치과 치과 백과사전",
          "description": `치과 의료 용어 ${total}개 정의 모음`,
          "hasDefinedTerm": entries.slice(0, 100).map((e: any) => ({
            "@type": "DefinedTerm",
            "name": e.term,
            "description": e.summary || '',
            "url": `${SITE}${encPath(e)}`
          }))
        },
        {
          "@type": "BreadcrumbList",
          "itemListElement": [
            { "@type": "ListItem", "position": 1, "name": "홈", "item": SITE },
            { "@type": "ListItem", "position": 2, "name": "치과 백과사전", "item": `${SITE}/encyclopedia` }
          ]
        }
      ]
    })

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>치과 백과사전 — ${total}개 치과 용어 총정리 | 서울가온치과</title>
<meta name="description" content="임플란트, 보철, 신경치료, 교정, 잇몸질환 등 치과 용어 ${total}개를 쉬운 말로 정리했습니다. 의정부 서울가온치과 치과 백과사전.">
<meta name="keywords" content="치과 용어, 치과 백과사전, 임플란트 용어, 치과 상식, 치과 용어 정리, 의정부 치과">
<link rel="canonical" href="${SITE}/encyclopedia">
<meta property="og:title" content="치과 백과사전 — ${total}개 치과 용어 총정리 | 서울가온치과">
<meta property="og:description" content="치과 용어 ${total}개를 쉬운 말로 정리한 치과 백과사전입니다.">
<meta property="og:url" content="${SITE}/encyclopedia">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE}/images/og-main.jpg">
<script type="application/ld+json">${jsonLd}</script>
<style>
.enc-hero{padding:7.5rem 1.5rem 2.5rem;text-align:center;max-width:900px;margin:0 auto}
.enc-hero h1{font-size:clamp(1.7rem,4vw,2.4rem);color:var(--ivory);margin-bottom:.6rem}
.enc-hero p{color:var(--stone-l);font-size:.95rem}
.enc-search-wrap{max-width:560px;margin:1.5rem auto 0;position:relative}
.enc-search-wrap input{width:100%;padding:.85rem 1.1rem .85rem 2.6rem;background:var(--ink);border:1px solid rgba(191,164,106,.25);border-radius:8px;color:var(--ivory);font-size:.95rem}
.enc-search-wrap i{position:absolute;left:1rem;top:50%;transform:translateY(-50%);color:var(--gold)}
.enc-tabs{display:flex;flex-wrap:wrap;gap:.5rem;justify-content:center;max-width:900px;margin:1.5rem auto 0;padding:0 1rem}
.enc-tab{padding:.4rem .85rem;background:var(--ink);border:1px solid rgba(191,164,106,.2);border-radius:20px;color:var(--stone-l);font-size:.8rem;text-decoration:none;transition:all .2s}
.enc-tab:hover{border-color:var(--gold);color:var(--gold)}
.enc-tab span{color:var(--gold);font-size:.72rem}
.enc-main{max-width:1100px;margin:0 auto;padding:1rem 1.5rem 4rem}
.enc-section{margin-top:2.5rem}
.enc-section h2{font-size:1.3rem;color:var(--ivory);border-bottom:1px solid rgba(191,164,106,.2);padding-bottom:.6rem;margin-bottom:1rem}
.enc-count{font-size:.8rem;color:var(--stone);font-weight:400}
.enc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:.8rem}
.enc-item{display:flex;flex-direction:column;gap:.3rem;padding:.9rem 1rem;background:var(--ink);border:1px solid rgba(191,164,106,.12);border-radius:8px;text-decoration:none;transition:border-color .2s,transform .2s}
.enc-item:hover{border-color:var(--gold);transform:translateY(-2px)}
.enc-item strong{color:var(--gold);font-size:.92rem}
.enc-item span{color:var(--stone-l);font-size:.78rem;line-height:1.45}
.enc-item.hide{display:none}
@media(max-width:768px){.enc-grid{grid-template-columns:1fr 1fr}.enc-item span{display:none}}
</style>
</head>
<body>
${NAV_HTML}
<main id="main-content" role="main">
  <div class="enc-hero">
    <h1><i class="fas fa-book-medical" style="color:var(--gold);margin-right:.5rem"></i>치과 백과사전</h1>
    <p>치과 용어 <strong style="color:var(--gold)">${total}개</strong>를 쉬운 말로 정리했습니다. 일반 건강정보이며, 진료 판단은 내원 상담에서 원장이 직접 합니다.</p>
    <div class="enc-search-wrap">
      <i class="fas fa-search"></i>
      <input type="search" id="enc-search" placeholder="용어 검색 (예: 임플란트, 신경치료, 골이식)" aria-label="치과 용어 검색">
    </div>
  </div>
  <nav class="enc-tabs" aria-label="카테고리">${tabsHtml}</nav>
  <div class="enc-main">
    ${sectionsHtml}
  </div>
</main>
${FOOTER_HTML}
${KAKAO_FLOAT}
<script src="/pages.js"></script>
<script>
var ham=document.querySelector('.hamburger'),mob=document.querySelector('.mob-menu');
if(ham&&mob){ham.addEventListener('click',function(){ham.classList.toggle('open');mob.classList.toggle('open')});mob.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){ham.classList.remove('open');mob.classList.remove('open')})})}
// 클라이언트 검색 필터 (SSR된 DOM 필터링 — SEO 영향 없음)
var si=document.getElementById('enc-search');
if(si){si.addEventListener('input',function(){var q=this.value.trim().toLowerCase();document.querySelectorAll('.enc-item').forEach(function(el){el.classList.toggle('hide',q&&el.getAttribute('data-term').indexOf(q)===-1)});document.querySelectorAll('.enc-section').forEach(function(s){var vis=s.querySelectorAll('.enc-item:not(.hide)').length;s.style.display=vis?'':'none'})})}
</script>
</body>
</html>`

    return c.html(html, 200, {
      'Cache-Control': 'public, max-age=3600, s-maxage=43200, stale-while-revalidate=43200',
      'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large',
    })
  } catch (e: any) {
    console.error('[SSR Encyclopedia List ERROR]', e.message)
    return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>치과 백과사전 | 서울가온치과</title></head><body><p>잠시 후 다시 시도해주세요.</p></body></html>`, 500)
  }
})

// ── SSR: 백과사전 상세 (id 또는 slug — DefinedTerm + FAQPage + MedicalWebPage) ──
app.get('/encyclopedia/:key', async (c) => {
  try {
    const db = c.env.DB
    await initDB(db)
    const key = decodeURIComponent(c.req.param('key'))
    // 동의어·중복 용어 → 대표 용어로 301 (2026-10-08: 치과 방사선 중복 dental-x-ray → dental-radiography)
    if (ENC_ALIASES[key]) return c.redirect(`/encyclopedia/${encodeURIComponent(ENC_ALIASES[key])}`, 301)

    let entry: any = null
    if (/^\d+$/.test(key)) {
      entry = await db.prepare('SELECT * FROM encyclopedia WHERE id = ? AND is_published = 1').bind(parseInt(key)).first()
      // id 접근인데 클린 slug 보유 → canonical URL로 301 (중복 콘텐츠 방지)
      if (entry && encSlugClean(entry.slug)) {
        return c.redirect(`/encyclopedia/${encodeURIComponent(ENC_ALIASES[entry.slug] || entry.slug)}`, 301)
      }
    }
    if (!entry) {
      entry = await db.prepare('SELECT * FROM encyclopedia WHERE slug = ? AND is_published = 1').bind(key).first()
    }
    if (!entry) {
      // term 명으로도 시도 (관용성)
      entry = await db.prepare('SELECT * FROM encyclopedia WHERE term = ? AND is_published = 1').bind(key).first()
    }

    if (!entry) {
      // 옛 slug → 새 slug 301 리다이렉트 (2026-06-30 slug 정규화 대응)
      const redirect = await db.prepare('SELECT new_slug FROM slug_redirects WHERE old_slug = ?').bind(key).first() as any
      if (redirect && redirect.new_slug) {
        return c.redirect(`/encyclopedia/${encodeURIComponent(redirect.new_slug)}`, 301)
      }
    }

    if (!entry) {
      return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>용어를 찾을 수 없습니다 | 서울가온치과</title>${HEAD_COMMON}</head><body>${NAV_HTML}<main style="min-height:60vh;display:flex;align-items:center;justify-content:center;text-align:center;padding-top:72px"><div><h1 style="color:var(--gold);font-size:2rem;margin-bottom:1rem">404</h1><p style="color:var(--stone-l);margin-bottom:2rem">해당 용어를 찾을 수 없습니다.</p><a href="/encyclopedia" style="color:var(--gold);text-decoration:underline">백과사전 목록으로 →</a></div></main>${FOOTER_HTML}${KAKAO_FLOAT}<script src="/pages.js"></script></body></html>`, 404)
    }

    // 조회수 증가 (fire-and-forget)
    c.executionCtx.waitUntil(
      db.prepare('UPDATE encyclopedia SET view_count = view_count + 1 WHERE id = ?').bind(entry.id).run().catch(() => {})
    )

    // 관련 용어 (같은 카테고리, 결정적 정렬 — 크롤러 안정성)
    const relResult = await db.prepare(
      'SELECT id, term, slug, summary FROM encyclopedia WHERE category = ? AND id != ? AND is_published = 1 ORDER BY view_count DESC, term ASC LIMIT 6'
    ).bind(entry.category, entry.id).all()
    const related: any[] = (relResult.results || []).filter((r: any) => !ENC_ALIASES[r.slug])

    // 전체 용어 (자동 크로스링크용 — 가벼운 3컬럼만)
    let allTerms: any[] = []
    try {
      const tr = await db.prepare('SELECT id, term, slug FROM encyclopedia WHERE is_published = 1').all()
      allTerms = (tr.results || []).filter((t: any) => !ENC_ALIASES[t.slug])
    } catch { /* ignore */ }

    // 보강 원고 (레포 데이터 파일 src/data/enc-enrich.ts — 원격 DB 미수정, 2026-10-08)
    const enrich = ENC_ENRICH[entry.slug]

    // 관련 블로그 글 (제목/내용에 용어 포함 — 콘텐츠 허브 내부링크)
    let relatedBlogs: any[] = []
    try {
      const br = await db.prepare(
        `SELECT id, title, created_at FROM blog_posts WHERE is_published = 1 AND (title LIKE ? OR content LIKE ?) ORDER BY created_at DESC LIMIT 4`
      ).bind(`%${entry.term}%`, `%${entry.term}%`).all()
      relatedBlogs = br.results || []
    } catch { /* ignore */ }

    // FAQ 수집
    const faqs: Array<{ q: string; a: string }> = []
    for (let i = 1; i <= 10; i++) {
      const q = entry[`faq_q${i}`], a = entry[`faq_a${i}`]
      if (q && a) faqs.push({ q, a })
    }
    if (enrich) {
      const normQ = (q: string) => q.replace(/[\s?？.!,·'"()]/g, '')
      const seenQ = new Set(faqs.map((f) => normQ(f.q)))
      for (const f of enrich.faqs) if (!seenQ.has(normQ(f.q))) { seenQ.add(normQ(f.q)); faqs.push(f) }
    }

    const canonicalPath = encPath(entry)
    const canonicalUrl = `${SITE}${canonicalPath}`
    const pageTitle = entry.seo_title || `${entry.term}이란? 뜻과 치료 정보 | 서울가온치과 치과 백과사전`
    const metaDesc = entry.seo_description || (entry.summary || '').substring(0, 155)
    const dbModDate = fmtDate(entry.updated_at || entry.created_at)
    // 보강 원고가 붙은 용어는 보강일(고정값)이 최종 수정일 — new Date() 금지
    const modDate = enrich && (!dbModDate || ENC_ENRICH_DATE > dbModDate) ? ENC_ENRICH_DATE : dbModDate
    const pubDate = fmtDate(entry.created_at)

    // JSON-LD: DefinedTerm + MedicalWebPage + FAQPage + BreadcrumbList
    const graph: any[] = [
      {
        "@type": "DefinedTerm",
        "@id": `${canonicalUrl}#term`,
        "name": entry.term,
        "description": entry.summary || metaDesc,
        "inDefinedTermSet": { "@type": "DefinedTermSet", "name": "서울가온치과 치과 백과사전", "url": `${SITE}/encyclopedia` },
        "url": canonicalUrl
      },
      {
        "@type": "MedicalWebPage",
        "@id": canonicalUrl,
        "name": pageTitle,
        "description": metaDesc,
        "url": canonicalUrl,
        "inLanguage": "ko",
        "datePublished": pubDate || undefined,
        "dateModified": modDate || undefined,
        "about": { "@type": "MedicalEntity", "name": entry.term },
        "mainEntity": { "@id": `${canonicalUrl}#term` },
        "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["h1", ".enc-summary"] },
        "publisher": CLINIC_REF,
        "isPartOf": WEBSITE_REF
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "홈", "item": SITE },
          { "@type": "ListItem", "position": 2, "name": "치과 백과사전", "item": `${SITE}/encyclopedia` },
          { "@type": "ListItem", "position": 3, "name": entry.term, "item": canonicalUrl }
        ]
      }
    ]
    if (faqs.length) {
      graph.push({
        "@type": "FAQPage",
        "@id": `${canonicalUrl}#faq`,
        "mainEntity": faqs.map(f => ({
          "@type": "Question",
          "name": f.q,
          "acceptedAnswer": { "@type": "Answer", "text": f.a }
        }))
      })
    }
    const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@graph": graph })

    const faqHtml = faqs.length ? `
    <section class="encd-faq" id="faq">
      <h2><i class="fas fa-question-circle" style="color:var(--gold);margin-right:.5rem"></i>${escHtml(entry.term)} 자주 묻는 질문</h2>
      ${faqs.map(f => `<details class="encd-faq-item">
        <summary>${escHtml(f.q)}</summary>
        <p>${escHtml(f.a)}</p>
      </details>`).join('')}
    </section>` : ''

    const relatedHtml = related.length ? `
    <section class="encd-related">
      <h2><i class="fas fa-link" style="color:var(--gold);margin-right:.5rem"></i>관련 용어</h2>
      <div class="encd-related-grid">
        ${related.map((r: any) => `<a href="${encPath(r)}" class="encd-related-card"><strong>${escHtml(r.term)}</strong><span>${escHtml((r.summary || '').substring(0, 70))}…</span></a>`).join('')}
      </div>
    </section>` : ''

    const treatmentLinks = (entry.related_treatment || '').split(/[,·]/).map((t: string) => t.trim()).filter(Boolean)
    const treatMap: Record<string, string> = {
      '임플란트': '/implant', '가이드 임플란트': '/implant', '뼈이식': '/bone-graft-implant',
      '신경치료': '/endodontics', '보존치료': '/endodontics', '심미치료': '/aesthetic',
      '라미네이트': '/laminate', '교정': '/orthodontics', '치아교정': '/orthodontics',
      '인비절라인': '/invisalign', '충치치료': '/cavity-treatment', '레진': '/cavity-treatment',
      '레진빌드업': '/resin-buildup', '잇몸치료': '/scaling-gum-treatment', '스케일링': '/scaling-gum-treatment',
      '크라운': '/crown', '보철': '/crown', '보철치료': '/crown', '미백': '/teeth-whitening', '치아미백': '/teeth-whitening',
      '사랑니': '/wisdom-tooth', '발치': '/wisdom-tooth', '소아치과': '/pediatric-dental', '정기검진': '/dental-checkup'
    }
    const treatPairs: Array<{ href: string; label: string }> = treatmentLinks.map((t: string) => ({ href: treatMap[t] || '/treatments', label: t }))
    if (enrich) for (const href of enrich.treat) {
      if (!treatPairs.some((p) => p.href === href)) treatPairs.push({ href, label: ENC_TREAT_LABELS[href] || href })
    }
    const treatHtml = treatPairs.length ? `
    <aside class="encd-treat">
      <h3>이 용어와 관련된 진료</h3>
      <div class="encd-treat-tags">${treatPairs.map((p) => `<a href="${p.href}">${escHtml(p.label)}</a>`).join('')}</div>
    </aside>` : ''

    // 관련 블로그 글 섹션 (콘텐츠 허브 — 백과사전 ↔ 블로그 양방향 링크)
    const blogsHtml = relatedBlogs.length ? `
    <section class="encd-blogs">
      <h2><i class="fas fa-newspaper" style="color:var(--gold);margin-right:.5rem"></i>${escHtml(entry.term)} 관련 블로그 글</h2>
      <ul class="encd-blogs-list">
        ${relatedBlogs.map((b: any) => `<li><a href="/blog/${b.id}">${escHtml(b.title)}</a><time datetime="${fmtDate(b.created_at)}">${fmtDate(b.created_at)}</time></li>`).join('')}
      </ul>
    </section>` : ''

    // 본문 자동 크로스링크 (다른 백과사전 용어 → 링크)
    const relSlugs = new Set(related.map((r: any) => r.slug))
    const enrichRel = enrich ? enrich.rel.filter((sl) => !relSlugs.has(sl)).map((sl) => allTerms.find((t: any) => t.slug === sl)).filter(Boolean) : []
    const enrichHtml = enrich ? enrich.sections.map((sec) => `<h2>${escHtml(sec.h)}</h2>${sec.p.map((x) => `<p>${escHtml(x)}</p>`).join('')}${sec.li && sec.li.length ? `<ul>${sec.li.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul>` : ''}`).join('')
      + (enrichRel.length ? `<p class="encd-seealso">함께 보면 좋은 용어: ${enrichRel.map((t: any) => `<a href="${encPath(t)}">${escHtml(t.term)}</a>`).join(' · ')}</p>` : '')
      : ''
    const bodyHtml = autoCrossLink(encFormatContent(encCleanContent(entry.slug, entry.content)) + (enrichHtml ? `<div class="encd-more">${enrichHtml}</div>` : ''), allTerms, entry.id)

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>${escHtml(pageTitle)}</title>
<meta name="description" content="${escHtml(metaDesc)}">
${entry.seo_keywords ? `<meta name="keywords" content="${escHtml(entry.seo_keywords)}">` : ''}
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:title" content="${escHtml(pageTitle)}">
<meta property="og:description" content="${escHtml(metaDesc)}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:type" content="article">
<meta property="og:image" content="${SITE}/images/og-main.jpg">
<meta property="og:locale" content="ko_KR">
<meta property="article:published_time" content="${pubDate}">
<meta property="article:modified_time" content="${modDate}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escHtml(pageTitle)}">
<meta name="twitter:description" content="${escHtml(metaDesc)}">
<script type="application/ld+json">${jsonLd}</script>
<style>
.encd-wrap{max-width:820px;margin:0 auto;padding:7.5rem 1.5rem 4rem}
.encd-bc{font-size:.78rem;color:var(--stone);margin-bottom:1.2rem}
.encd-bc a{color:var(--stone-l);text-decoration:none}
.encd-bc a:hover{color:var(--gold)}
.encd-cat{display:inline-block;padding:.25rem .7rem;background:rgba(191,164,106,.12);border:1px solid rgba(191,164,106,.3);border-radius:14px;color:var(--gold);font-size:.75rem;margin-bottom:.8rem}
.encd-wrap h1{font-size:clamp(1.6rem,4vw,2.2rem);color:var(--ivory);margin-bottom:.8rem;line-height:1.3}
.enc-summary{font-size:1.02rem;color:var(--stone-l);line-height:1.7;padding:1rem 1.2rem;background:var(--ink);border-left:3px solid var(--gold);border-radius:0 8px 8px 0;margin-bottom:2rem}
.encd-body{color:var(--stone-l);line-height:1.8;font-size:.95rem}
.encd-body h2{font-size:1.25rem;color:var(--ivory);margin:2rem 0 .8rem;padding-bottom:.4rem;border-bottom:1px solid rgba(191,164,106,.15)}
.encd-body h3{font-size:1.05rem;color:var(--gold);margin:1.4rem 0 .6rem}
.encd-body p{margin:.7rem 0}
.encd-body ul{margin:.7rem 0;padding-left:1.3rem}
.encd-body li{margin:.35rem 0}
.encd-body strong{color:var(--ivory)}
.encd-faq{margin-top:2.5rem}
.encd-faq h2{font-size:1.25rem;color:var(--ivory);margin-bottom:1rem}
.encd-faq-item{background:var(--ink);border:1px solid rgba(191,164,106,.15);border-radius:8px;margin-bottom:.6rem;overflow:hidden}
.encd-faq-item summary{padding:.9rem 1.1rem;cursor:pointer;color:var(--ivory);font-size:.92rem;font-weight:600;list-style:none;position:relative}
.encd-faq-item summary::after{content:'+';position:absolute;right:1.1rem;color:var(--gold);font-size:1.1rem}
.encd-faq-item[open] summary::after{content:'−'}
.encd-faq-item p{padding:0 1.1rem 1rem;margin:0;color:var(--stone-l);font-size:.88rem;line-height:1.7}
.encd-related{margin-top:2.5rem}
.encd-related h2{font-size:1.25rem;color:var(--ivory);margin-bottom:1rem}
.encd-related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:.7rem}
.encd-related-card{display:flex;flex-direction:column;gap:.25rem;padding:.85rem 1rem;background:var(--ink);border:1px solid rgba(191,164,106,.12);border-radius:8px;text-decoration:none;transition:border-color .2s}
.encd-related-card:hover{border-color:var(--gold)}
.encd-related-card strong{color:var(--gold);font-size:.88rem}
.encd-related-card span{color:var(--stone-l);font-size:.75rem;line-height:1.4}
.encd-treat{margin-top:2rem;padding:1.1rem 1.3rem;background:rgba(191,164,106,.06);border:1px solid rgba(191,164,106,.2);border-radius:10px}
.encd-treat h3{font-size:.95rem;color:var(--ivory);margin-bottom:.7rem}
.encd-treat-tags{display:flex;flex-wrap:wrap;gap:.5rem}
.encd-treat-tags a{padding:.35rem .8rem;background:var(--ink);border:1px solid rgba(191,164,106,.3);border-radius:16px;color:var(--gold);font-size:.8rem;text-decoration:none}
.encd-treat-tags a:hover{background:rgba(191,164,106,.15)}
.encd-local{margin-top:2rem;font-size:.72rem;color:var(--stone);line-height:1.8}
.encd-cta{margin-top:2.5rem;text-align:center;padding:1.8rem;background:var(--ink);border:1px solid rgba(191,164,106,.2);border-radius:12px}
.encd-cta p{color:var(--stone-l);margin-bottom:1rem;font-size:.92rem}
.encd-cta a{display:inline-flex;align-items:center;gap:.5rem;padding:.75rem 1.6rem;background:var(--gold);color:#050504;border-radius:8px;text-decoration:none;font-weight:700;font-size:.9rem}
.encd-meta{margin-top:1.5rem;font-size:.72rem;color:var(--stone)}
.encd-more{margin-top:1.6rem;padding-top:.4rem;border-top:1px solid rgba(191,164,106,.12)}
.encd-seealso{margin-top:1.4rem;font-size:.88rem}
.encd-seealso a{color:var(--gold);text-decoration:none;border-bottom:1px dotted rgba(191,164,106,.5)}
.encd-blogs{margin-top:2.5rem}
.encd-blogs h2{font-size:1.25rem;color:var(--ivory);margin-bottom:1rem}
.encd-blogs-list{list-style:none;padding:0;margin:0}
.encd-blogs-list li{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.7rem 1rem;background:var(--ink);border:1px solid rgba(191,164,106,.12);border-radius:8px;margin-bottom:.5rem}
.encd-blogs-list a{color:var(--stone-l);text-decoration:none;font-size:.9rem;flex:1}
.encd-blogs-list a:hover{color:var(--gold)}
.encd-blogs-list time{color:var(--stone);font-size:.72rem;white-space:nowrap}
${ENC_XLINK_CSS}
</style>
</head>
<body>
${NAV_HTML}
<main id="main-content" role="main">
  <article class="encd-wrap" itemscope itemtype="https://schema.org/MedicalWebPage">
    <nav class="encd-bc" aria-label="브레드크럼"><a href="/">홈</a> › <a href="/encyclopedia">치과 백과사전</a> › ${escHtml(entry.term)}</nav>
    <span class="encd-cat">${escHtml(entry.category || '일반')}</span>
    <h1 itemprop="name">${escHtml(entry.term)}</h1>
    ${entry.summary ? `<p class="enc-summary" itemprop="description">${escHtml(entry.summary)}</p>` : ''}
    <div class="encd-body" itemprop="text">${bodyHtml}</div>
    ${faqHtml}
    ${treatHtml}
    ${blogsHtml}
    ${relatedHtml}
    <div class="encd-cta">
      <p><strong style="color:var(--ivory)">${escHtml(entry.term)}</strong>에 대해 더 궁금하신가요? 서울대 출신 의료진이 직접 상담해 드립니다.</p>
      <a href="tel:0507-1325-3377"><i class="fas fa-phone"></i> 전화 상담: 0507-1325-3377</a>
    </div>
    <p class="encd-local">의정부 ${escHtml(entry.term)} · 탑석역 ${escHtml(entry.term)} · 민락동 ${escHtml(entry.term)} — 의정부시 용현동 서울가온치과 치과 백과사전</p>
    <p class="encd-meta">일반 건강정보입니다. 진료 판단은 내원 상담에서 원장이 직접 합니다. · 최종 수정일: ${modDate} · <a href="/encyclopedia" style="color:var(--gold)">전체 용어 보기 →</a></p>
  </article>
</main>
${FOOTER_HTML}
${KAKAO_FLOAT}
<script src="/pages.js"></script>
<script>
var ham=document.querySelector('.hamburger'),mob=document.querySelector('.mob-menu');
if(ham&&mob){ham.addEventListener('click',function(){ham.classList.toggle('open');mob.classList.toggle('open')});mob.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){ham.classList.remove('open');mob.classList.remove('open')})})}
</script>
</body>
</html>`

    return c.html(html, 200, {
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200',
      'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large',
    })
  } catch (e: any) {
    console.error('[SSR Encyclopedia Detail ERROR]', e.message)
    return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>치과 백과사전 | 서울가온치과</title></head><body><p>잠시 후 다시 시도해주세요.</p></body></html>`, 500)
  }
})

// ══════════════════════════════════════════════════
//  SSR — 지역명+핵심진료 SEO 랜딩페이지 (구글 상위노출용)
// ══════════════════════════════════════════════════

// 랜딩페이지 데이터 정의
interface LandingPageData {
  slug: string
  title: string
  metaDesc: string
  h1: string
  heroSub: string
  keywords: string
  category: string
  sections: Array<{
    heading: string
    content: string
  }>
  faqs: Array<{
    q: string
    a: string
  }>
  ctaText: string
  relatedLinks: Array<{ href: string; label: string }>
}

const LANDING_PAGES: LandingPageData[] = [
  // ── 1. 의정부 치과 (대표 키워드 허브) — 2026-10-08 허브 보강: 위치·진료시간·의료진·진료 링크·FAQ ──
  {
    slug: 'uijeongbu-dental',
    title: '의정부 치과 | 서울가온치과',
    metaDesc: '의정부 치과 서울가온치과 안내. 의정부시 용민로 22 골드자이프라자 4층, 탑석역 1번 출구 도보 약 5분. 월·화·수·금 09:30~18:30, 목 20:30까지 야간진료, 토 09:30~14:00. 임플란트·신경치료·앞니 심미·충치·잇몸·사랑니 진료 안내.',
    h1: '의정부 치과',
    heroSub: '서울가온치과 · 의정부시 용현동 탑석센트럴자이 정문 앞 · 탑석역 1번 출구 도보 약 5분',
    keywords: '의정부 치과, 의정부치과, 의정부 치과의원, 탑석역 치과, 용현동 치과, 민락동 치과, 의정부 야간진료 치과, 의정부 토요일 치과',
    category: '종합진료',
    sections: [
      {
        heading: '의정부 치과 서울가온치과는 어디에 있나요?',
        content: `<p>서울가온치과는 <strong>경기도 의정부시 용민로 22, 골드자이프라자 4층</strong>(용현동)에 있습니다. 탑석센트럴자이 아파트 정문 바로 앞, 1층에 배스킨라빈스가 있는 건물이라 처음 오시는 분도 건물을 찾기 쉽습니다.</p>
<ul>
<li><strong>지하철</strong> — 탑석역 1번 출구에서 걸어서 약 5분</li>
<li><strong>버스</strong> — 탑석센트럴자이 정류장 하차 (201, 201-1, 72번 등)</li>
<li><strong>자가용</strong> — 맞은편 제일식자재마트 지하주차장 이용, 진료 후 무료 주차 쿠폰 제공</li>
</ul>
<p>용현동·탑석 생활권은 걸어서, 민락동·장암동·신곡동 쪽에서는 버스나 차로 짧게 오실 수 있는 위치입니다. 동네별 길 안내는 <a href="/tapseok-dental">탑석역 치과</a>, <a href="/minrak-dental">민락동 치과</a> 페이지에 따로 정리해 두었습니다. 지도에서 바로 확인하시려면 <a href="https://map.naver.com/p/search/%EC%84%9C%EC%9A%B8%EA%B0%80%EC%98%A8%EC%B9%98%EA%B3%BC" target="_blank" rel="noopener">네이버 지도에서 서울가온치과 보기</a>를 눌러 주세요.</p>`
      },
      {
        heading: '진료시간 — 목요일은 밤 8시 30분까지 진료합니다',
        content: `<table class="hub-hours" style="width:100%;border-collapse:collapse;margin:.5rem 0 1rem;font-size:.92rem">
<thead><tr><th style="text-align:left;padding:.55rem;border-bottom:1px solid rgba(191,164,106,.35)">요일</th><th style="text-align:left;padding:.55rem;border-bottom:1px solid rgba(191,164,106,.35)">진료시간</th></tr></thead>
<tbody>
<tr><td style="padding:.55rem;border-bottom:1px solid rgba(191,164,106,.15)">월 · 화 · 수 · 금</td><td style="padding:.55rem;border-bottom:1px solid rgba(191,164,106,.15)">09:30 ~ 18:30</td></tr>
<tr><td style="padding:.55rem;border-bottom:1px solid rgba(191,164,106,.15)"><strong>목요일 (야간진료)</strong></td><td style="padding:.55rem;border-bottom:1px solid rgba(191,164,106,.15)"><strong>09:30 ~ 20:30</strong></td></tr>
<tr><td style="padding:.55rem;border-bottom:1px solid rgba(191,164,106,.15)">토요일</td><td style="padding:.55rem;border-bottom:1px solid rgba(191,164,106,.15)">09:30 ~ 14:00</td></tr>
<tr><td style="padding:.55rem;border-bottom:1px solid rgba(191,164,106,.15)">점심시간</td><td style="padding:.55rem;border-bottom:1px solid rgba(191,164,106,.15)">12:30 ~ 14:00</td></tr>
<tr><td style="padding:.55rem">일요일 · 공휴일</td><td style="padding:.55rem">휴진</td></tr>
</tbody></table>
<p>평일 낮에 시간을 내기 어려운 직장인·학생은 목요일 저녁 시간을 많이 이용하십니다. 야간이라고 진료 범위가 줄지 않으며 자세한 안내는 <a href="/night-dental">의정부 야간진료 치과</a> 페이지에 있습니다. 휴진·진료시간 변경은 <a href="/notice">공지사항</a>에 먼저 올립니다.</p>`
      },
      {
        heading: '어떤 의료진이 진료하나요?',
        content: `<p><strong>현진호 대표원장</strong>은 서울대학교 치의학과를 졸업한 통합치의학과 전문의로, 임플란트와 보철(씌우는 치료)을 중점적으로 진료합니다. CT 영상을 바탕으로 식립 위치를 미리 계획하는 가이드 임플란트를 시행합니다.</p>
<p><strong>조은비 원장</strong>은 서울대학교 치의학대학원 치과보존과 전문의로, 신경치료와 레진 등 자연치아를 살리는 치료를 맡고 있습니다. 미세현미경으로 신경관 내부를 확대해 보며 치료합니다. 두 원장의 경력은 <a href="/doctors">의료진 소개</a>에서 확인하실 수 있습니다.</p>`
      },
      {
        heading: '의정부 치과에서 많이 찾는 진료',
        content: `<ul>
<li><a href="/implant"><strong>임플란트</strong></a> — 치아를 잃은 자리의 회복. 뼈가 부족하면 <a href="/bone-graft-implant">뼈이식 임플란트</a>, 만 65세 이상은 <a href="/senior-implant">건강보험 임플란트</a></li>
<li><a href="/endodontics"><strong>신경치료</strong></a> — 깊은 충치·금 간 치아의 통증 치료와 재신경치료</li>
<li><a href="/aesthetic"><strong>앞니 심미치료</strong></a> — <a href="/laminate">라미네이트</a>, 지르코니아 <a href="/crown">크라운</a>, <a href="/resin-buildup">레진빌드업</a></li>
<li><a href="/cavity-treatment"><strong>충치치료</strong></a>와 <a href="/scaling-gum-treatment"><strong>스케일링·잇몸치료</strong></a> — 만 19세 이상 연 1회 스케일링 건강보험 적용</li>
<li><a href="/wisdom-tooth"><strong>사랑니 발치</strong></a>, <a href="/orthodontics"><strong>치아교정</strong></a>·<a href="/invisalign">인비절라인</a>, <a href="/pediatric-dental"><strong>소아치과</strong></a>, <a href="/dental-checkup"><strong>정기검진</strong></a></li>
</ul>`
      },
      {
        heading: '의정부에서 치과를 고를 때 확인해 볼 것',
        content: `<p>집이나 직장에서 가까운 곳이 가장 오래 다니기 좋지만, 몇 가지는 미리 확인해 두시면 치료 중에 덜 흔들립니다.</p>
<ul>
<li><strong>설명을 사진으로 보여 주는지</strong> — 엑스레이·CT 화면을 같이 보며 왜 이 치료가 필요한지 듣고 나면 결정이 쉬워집니다.</li>
<li><strong>비용을 미리 공개하는지</strong> — 비급여 진료비를 홈페이지나 서면으로 확인할 수 있으면 상담 뒤에 금액이 바뀌는 걱정이 줄어듭니다.</li>
<li><strong>진료과목별 담당이 정해져 있는지</strong> — 임플란트·보철과 신경치료처럼 성격이 다른 치료를 누가 맡는지 알아 두면 좋습니다.</li>
<li><strong>내 생활 시간과 맞는지</strong> — 임플란트나 신경치료는 몇 차례 다시 와야 하므로 저녁·토요일 진료가 가능한지 확인해 보세요.</li>
</ul>
<p>서울가온치과는 치료를 서두르기보다 지금 꼭 해야 할 것과 지켜봐도 되는 것을 구분해 말씀드리는 것을 원칙으로 합니다.</p>`
      },
      {
        heading: '처음 방문하시면 이렇게 진행됩니다',
        content: `<ol>
<li><strong>예약</strong> — 전화(<a href="tel:0507-1325-3377">0507-1325-3377</a>), <a href="https://booking.naver.com/booking/13/bizes/781025" target="_blank" rel="noopener">네이버 예약</a>, <a href="https://pf.kakao.com/_LLxhwG/chat" target="_blank" rel="noopener">카카오톡 상담</a> 중 편한 방법으로 잡으시면 됩니다.</li>
<li><strong>검사</strong> — 불편한 부위를 듣고 구강 상태를 살핀 뒤, 필요하면 파노라마나 CT를 촬영합니다.</li>
<li><strong>설명</strong> — 촬영 사진을 함께 보면서 지금 꼭 필요한 치료와 지켜봐도 되는 부분을 나눠 말씀드리고, 치료 계획과 비용은 서면으로 안내합니다.</li>
<li><strong>치료 결정</strong> — 설명을 듣고 충분히 생각하신 뒤 결정하셔도 됩니다. 비급여 항목 기준 비용은 <a href="/guide">내원 안내</a>의 수가표에 공개해 두었습니다.</li>
</ol>
<p>신분증과 건강보험 자격 확인이 필요하고, 드시는 약이 있으면 약 이름을 메모해 오시면 진료 계획을 세우는 데 도움이 됩니다.</p>`
      }
    ],
    faqs: [
      { q: '의정부 서울가온치과 위치가 어디인가요?', a: '경기도 의정부시 용민로 22, 골드자이프라자 4층(용현동)입니다. 탑석센트럴자이 정문 앞 배스킨라빈스 건물이며, 탑석역 1번 출구에서 걸어서 약 5분 걸립니다.' },
      { q: '차를 가지고 가면 어디에 주차하나요?', a: '맞은편 제일식자재마트 지하주차장을 이용하시면 됩니다. 진료를 받으시면 무료 주차 쿠폰을 드립니다.' },
      { q: '퇴근 후 저녁에도 진료를 받을 수 있나요?', a: '네. 매주 목요일은 밤 8시 30분(20:30)까지 야간진료를 합니다. 다른 평일은 18:30까지이니, 저녁 내원은 목요일로 예약해 주세요.' },
      { q: '토요일과 일요일에도 문을 여나요?', a: '토요일은 09:30부터 14:00까지 점심시간 없이 진료합니다. 일요일과 공휴일은 휴진입니다.' },
      { q: '예약 없이 가도 진료받을 수 있나요?', a: '예약 환자 위주로 진료하므로 미리 전화(0507-1325-3377)나 네이버 예약으로 시간을 잡고 오시면 기다리는 시간이 줄어듭니다. 갑자기 아프신 경우에는 먼저 전화로 상황을 말씀해 주세요.' },
      { q: '치료비는 언제 알 수 있나요?', a: '검사 후 치료 계획을 설명드리면서 비용을 서면으로 먼저 안내합니다. 건강보험 적용 진료는 보험 기준에 따르고, 비급여 기준 비용은 내원 안내 페이지 수가표에서 미리 보실 수 있습니다.' },
    ],
    ctaText: '의정부 치과 상담 예약하기',
    relatedLinks: [
      { href: '/implant', label: '의정부 임플란트' },
      { href: '/endodontics', label: '의정부 신경치료' },
      { href: '/aesthetic', label: '의정부 앞니 심미치료' },
      { href: '/night-dental', label: '목요일 야간진료 안내' },
      { href: '/tapseok-dental', label: '탑석역 치과' },
      { href: '/minrak-dental', label: '민락동 치과' },
      { href: '/guide', label: '오시는 길 · 수가 안내' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 2. 의정부 신경치료 ──
  {
    slug: 'endodontics',
    title: '의정부 신경치료 | 서울가온치과 — 서울대 보존과 전문의 직접 시행',
    metaDesc: '의정부 신경치료 서울가온치과. 서울대학교 보존과 전문의 조은비 원장이 미세현미경으로 직접 시행합니다. 정확한 진단, 최소 삭제, 높은 성공률. 탑석역 5분. ☎ 0507-1325-3377',
    h1: '의정부 신경치료 — 서울대 보존과 전문의',
    heroSub: '서울대학교 보존과 전문의가 미세현미경으로 직접 시행하는 정밀 신경치료',
    keywords: '의정부 신경치료, 의정부 신경치료 잘하는곳, 의정부 치과 신경치료, 탑석역 신경치료, 신경치료 통증, 신경치료 비용, 의정부 보존과, 의정부 치아살리기',
    category: '신경치료',
    sections: [
      {
        heading: '신경치료, 왜 서울가온치과일까요?',
        content: `<p>신경치료는 <strong>치아를 뽑지 않고 살리는 마지막 기회</strong>입니다. 서울가온치과에서는 <strong>서울대학교 보존과 전문의 조은비 원장</strong>이 미세현미경을 활용하여 직접 신경치료를 시행합니다.</p>
<p>보존과 전문의란 <strong>충치와 신경치료를 전문적으로 수련한 의사</strong>를 말합니다. 일반 치과의사와 달리 2~3년의 추가 수련을 통해 복잡한 신경관 구조를 정밀하게 치료할 수 있는 전문성을 갖추고 있습니다.</p>`
      },
      {
        heading: '서울가온치과 신경치료의 차이점',
        content: `<ul>
<li><strong>미세현미경 사용</strong> — 육안으로 보이지 않는 미세 신경관까지 정확히 확인하고 치료합니다</li>
<li><strong>Ni-Ti 파일 사용</strong> — 유연한 니켈-티타늄 기구로 곡선형 신경관도 안전하게 성형합니다</li>
<li><strong>최소 삭제 원칙</strong> — 건강한 치아 조직은 최대한 보존하며 감염 부위만 정밀 제거합니다</li>
<li><strong>전문의 직접 시행</strong> — 처음부터 끝까지 조은비 원장(서울대 보존과 전문의)이 직접 치료합니다</li>
</ul>`
      },
      {
        heading: '신경치료가 필요한 경우',
        content: `<p>다음과 같은 증상이 있다면 신경치료가 필요할 수 있습니다:</p>
<ul>
<li>찬물이나 뜨거운 음식에 <strong>심한 통증</strong>이 있는 경우</li>
<li><strong>가만히 있어도 욱신거리는</strong> 통증이 있는 경우</li>
<li>씹을 때 <strong>특정 치아가 아픈</strong> 경우</li>
<li>잇몸에 <strong>고름이 나오는</strong> 경우</li>
<li>충치가 심해 <strong>치아 내부 신경까지 감염</strong>된 경우</li>
</ul>
<p>이런 증상이 있다면 빠른 시일 내에 내원하셔서 정확한 진단을 받으시기 바랍니다.</p>`
      },
      {
        heading: '신경치료 과정',
        content: `<ol>
<li><strong>정밀 진단</strong> — X-ray·CT 촬영으로 신경관 상태를 정확히 파악합니다</li>
<li><strong>마취 후 감염 제거</strong> — 충분한 마취 후 감염된 신경 조직을 미세현미경 하에 제거합니다</li>
<li><strong>신경관 성형·세척</strong> — Ni-Ti 파일로 신경관을 성형하고 소독액으로 철저히 세척합니다</li>
<li><strong>밀봉 충전</strong> — 생체적합성 재료로 신경관을 빈틈없이 밀봉합니다</li>
<li><strong>보철 수복</strong> — 크라운 또는 레진빌드업으로 치아를 원래 형태로 복원합니다</li>
</ol>`
      }
    ],
    faqs: [
      { q: '신경치료는 아프나요?', a: '충분한 마취 후 진행하므로 치료 중에는 거의 통증이 없습니다. 치료 후 1~2일 정도 약간의 불편감이 있을 수 있으나 진통제로 조절 가능합니다.' },
      { q: '신경치료 비용은 얼마인가요?', a: '신경치료는 건강보험이 적용되어 본인부담금은 1만~3만원 수준입니다. 이후 크라운 수복 비용은 재료에 따라 다르며, 진료 전 상세히 안내해 드립니다.' },
      { q: '신경치료 몇 번 와야 하나요?', a: '일반적으로 2~3회 내원이 필요합니다. 감염 정도와 치아 상태에 따라 달라질 수 있으며, 첫 내원 시 정확한 치료 계획을 설명드립니다.' },
      { q: '신경치료 후 크라운을 꼭 해야 하나요?', a: '서울가온치과에서는 반드시 크라운이 필요한 경우와 레진빌드업으로 충분한 경우를 정확히 구분하여 안내합니다. 불필요한 크라운 치료는 권하지 않습니다.' },
    ],
    ctaText: '의정부 신경치료 상담 예약',
    relatedLinks: [
      { href: '/resin-buildup', label: '레진빌드업' },
      { href: '/crown', label: '크라운 치료' },
      { href: '/implant', label: '의정부 임플란트' },
      { href: '/cavity-treatment', label: '의정부 충치치료' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 3. 의정부 인비절라인 ──
  {
    slug: 'invisalign',
    title: '의정부 인비절라인 | 서울가온치과 — 투명교정, 탑석역 5분',
    metaDesc: '의정부 인비절라인 투명교정 서울가온치과. 눈에 띄지 않는 투명 교정장치로 가지런한 치아를 만듭니다. 정밀 3D 시뮬레이션, 맞춤 치료 계획. 탑석역 5분. ☎ 0507-1325-3377',
    h1: '의정부 인비절라인 — 투명교정 중점 진료',
    heroSub: '눈에 띄지 않는 투명 교정장치로 가지런한 치아를 완성합니다',
    keywords: '의정부 인비절라인, 의정부 투명교정, 의정부 치아교정, 인비절라인 비용, 인비절라인 후기, 의정부 교정치과, 탑석역 교정, 인비절라인 기간',
    category: '치아교정',
    sections: [
      {
        heading: '인비절라인이란?',
        content: `<p>인비절라인은 <strong>투명한 플라스틱 장치</strong>를 이용한 치아교정 방법입니다. 전통적인 금속 브라켓과 달리 <strong>눈에 거의 보이지 않아</strong> 교정 중에도 자연스러운 미소를 유지할 수 있습니다.</p>
<p>서울가온치과에서는 <strong>3D 디지털 스캔과 시뮬레이션</strong>을 통해 치료 시작 전부터 최종 결과를 미리 확인할 수 있습니다.</p>`
      },
      {
        heading: '인비절라인의 장점',
        content: `<ul>
<li><strong>심미성</strong> — 투명하여 착용 중에도 티가 나지 않습니다</li>
<li><strong>편의성</strong> — 탈착이 가능하여 식사와 양치에 불편이 없습니다</li>
<li><strong>위생적</strong> — 장치를 분리하고 깨끗이 세척할 수 있어 충치·잇몸병 위험이 낮습니다</li>
<li><strong>편안함</strong> — 금속 브라켓 없이 부드러운 장치로 구강 점막 자극이 적습니다</li>
<li><strong>예측 가능</strong> — 3D 시뮬레이션으로 치료 결과를 사전에 확인합니다</li>
</ul>`
      },
      {
        heading: '서울가온치과 인비절라인 치료 과정',
        content: `<ol>
<li><strong>상담 및 정밀 검사</strong> — 구강 검진, X-ray, 3D 스캔으로 현재 상태를 정확히 파악합니다</li>
<li><strong>맞춤 치료 계획</strong> — 3D 시뮬레이션으로 치료 과정과 최종 결과를 시각적으로 확인합니다</li>
<li><strong>맞춤 장치 제작</strong> — 개인의 치아에 정확히 맞는 투명 교정장치를 제작합니다</li>
<li><strong>교정 진행</strong> — 2주마다 새 장치로 교체하며 치아를 점진적으로 이동시킵니다</li>
<li><strong>정기 검진</strong> — 4~6주 간격으로 내원하여 진행 상황을 확인합니다</li>
<li><strong>유지 관리</strong> — 교정 완료 후 유지장치로 결과를 안정적으로 유지합니다</li>
</ol>`
      },
      {
        heading: '인비절라인이 적합한 경우',
        content: `<ul>
<li>앞니가 <strong>삐뚤빼뚤</strong>한 경우</li>
<li><strong>치아 사이 공간</strong>이 벌어진 경우</li>
<li><strong>앞니 돌출</strong>(덧니)이 있는 경우</li>
<li><strong>이전 교정 후 재발</strong>한 경우</li>
<li>직업상 <strong>보이지 않는 교정</strong>을 원하는 경우</li>
</ul>
<p>심한 부정교합의 경우 다른 교정 방법이 더 적합할 수 있으므로, 정확한 상담 후 최적의 방법을 안내해 드립니다.</p>`
      }
    ],
    faqs: [
      { q: '인비절라인 비용은 얼마인가요?', a: '교정 범위와 난이도에 따라 다르며, 상담 후 정확한 비용을 안내해 드립니다. 무이자 분할 납부도 가능합니다.' },
      { q: '인비절라인 교정 기간은 얼마나 되나요?', a: '간단한 배열의 경우 6개월~1년, 전체 교정의 경우 1년~2년 정도 소요됩니다. 3D 시뮬레이션으로 예상 기간을 미리 확인하실 수 있습니다.' },
      { q: '인비절라인은 아프나요?', a: '새 장치로 교체 후 1~2일 정도 가벼운 압박감이 있을 수 있지만, 금속 교정에 비해 통증이 적습니다.' },
      { q: '하루에 몇 시간 착용해야 하나요?', a: '하루 20~22시간 착용을 권장합니다. 식사와 양치 시에만 분리합니다.' },
    ],
    ctaText: '인비절라인 무료 상담 예약',
    relatedLinks: [
      { href: '/orthodontics', label: '의정부 치아교정' },
      { href: '/aesthetic', label: '의정부 심미치료' },
      { href: '/laminate', label: '의정부 최소삭제 라미네이트' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 4. 의정부 치아교정 ──
  {
    slug: 'orthodontics',
    title: '의정부 치아교정 | 서울가온치과 — 인비절라인·투명교정 중점 진료',
    metaDesc: '의정부 치아교정 서울가온치과. 인비절라인 투명교정, 부분교정, 심미교정까지. 3D 디지털 시뮬레이션으로 정확한 치료 계획. 탑석역 5분. ☎ 0507-1325-3377',
    h1: '의정부 치아교정 — 인비절라인·투명교정 중점 진료',
    heroSub: '가지런한 치아, 건강한 교합 — 나에게 맞는 최적의 교정 방법을 찾아드립니다',
    keywords: '의정부 치아교정, 의정부 교정치과, 의정부 교정, 의정부 투명교정, 의정부 부분교정, 의정부 치아교정 비용, 탑석역 교정치과, 의정부 성인교정',
    category: '치아교정',
    sections: [
      {
        heading: '치아교정이 필요한 이유',
        content: `<p>치아교정은 단순히 <strong>미용 목적</strong>만이 아닙니다. 가지런하지 않은 치아는 충치와 잇몸병의 원인이 되고, <strong>잘못된 교합은 턱관절 장애</strong>를 유발할 수 있습니다.</p>
<p>서울가온치과에서는 환자의 교합 상태를 정밀하게 분석하여 <strong>건강한 교합과 아름다운 미소</strong>를 동시에 달성하는 교정 치료를 제공합니다.</p>`
      },
      {
        heading: '서울가온치과 교정 치료 종류',
        content: `<ul>
<li><strong>인비절라인</strong> — 투명 교정장치. 눈에 보이지 않으며 탈착 가능. 심미성 최고</li>
<li><strong>부분교정</strong> — 앞니 부분만 교정. 기간 짧고 비용 효율적</li>
<li><strong>심미교정</strong> — 세라믹·투명 브라켓을 사용하여 눈에 덜 띄는 교정</li>
</ul>
<p>환자의 치아 상태와 라이프스타일에 맞는 최적의 교정 방법을 상담 후 추천해 드립니다.</p>`
      },
      {
        heading: '교정 치료 과정',
        content: `<ol>
<li><strong>무료 상담</strong> — 현재 치아 상태 확인 및 교정 필요성 판단</li>
<li><strong>정밀 검사</strong> — X-ray, 3D 구강 스캔, 교합 분석</li>
<li><strong>치료 계획 수립</strong> — 3D 시뮬레이션으로 예상 결과 확인</li>
<li><strong>교정 장치 장착</strong> — 맞춤 제작된 장치로 교정 시작</li>
<li><strong>정기 내원</strong> — 월 1회 내원으로 진행 상황 체크</li>
<li><strong>교정 완료 + 유지</strong> — 유지장치로 결과 안정화</li>
</ol>`
      }
    ],
    faqs: [
      { q: '성인도 치아교정이 가능한가요?', a: '네, 성인 교정은 충분히 가능합니다. 오히려 성인은 치료 계획을 잘 따라주시기 때문에 좋은 결과를 얻는 경우가 많습니다.' },
      { q: '치아교정 비용은 어떻게 되나요?', a: '교정 종류와 범위에 따라 다릅니다. 상담 시 정확한 비용을 안내드리며, 무이자 분할 납부가 가능합니다.' },
      { q: '교정 기간은 보통 얼마나 걸리나요?', a: '부분교정은 6개월~1년, 전체 교정은 1년~2년 정도 소요됩니다. 개인 차이가 있으므로 상담 시 정확히 안내드립니다.' },
    ],
    ctaText: '치아교정 무료 상담 예약',
    relatedLinks: [
      { href: '/invisalign', label: '의정부 인비절라인' },
      { href: '/aesthetic', label: '의정부 심미치료' },
      { href: '/laminate', label: '의정부 최소삭제 라미네이트' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // (구 5. 글로우네이트 랜딩페이지 제거됨 — /glownate → /laminate 301 리다이렉트로 대체. 2026-07-21)
  // ── 6. 의정부 충치치료 ──
  {
    slug: 'cavity-treatment',
    title: '의정부 충치치료 | 서울가온치과 — 최소삭제·자연치아 보존 원칙',
    metaDesc: '의정부 충치치료 서울가온치과. 충치 부위만 정밀 제거, 건강한 치아 최대 보존. 레진 직접수복·레진빌드업으로 자연스러운 결과. 서울대 보존과 전문의. 탑석역 5분. ☎ 0507-1325-3377',
    h1: '의정부 충치치료 — 자연치아 보존 원칙',
    heroSub: '충치 부위만 정밀하게 제거하고, 건강한 치아는 최대한 보존합니다',
    keywords: '의정부 충치치료, 의정부 충치, 의정부 치과 충치, 충치치료 비용, 의정부 레진, 의정부 레진치료, 탑석역 충치, 충치 통증, 의정부 어금니 충치',
    category: '충치치료',
    sections: [
      {
        heading: '서울가온치과의 충치치료 원칙',
        content: `<p>서울가온치과는 <strong>"필요한 만큼만 치료"</strong>하는 원칙을 지킵니다. 충치가 있는 부분만 정밀하게 제거하고, 건강한 치아 조직은 최대한 보존하는 <strong>최소침습(MI) 치료</strong>를 시행합니다.</p>
<p>서울대 보존과 전문의 조은비 원장이 직접 진단하여, 불필요한 크라운이나 인레이 대신 <strong>레진 직접수복 또는 레진빌드업</strong>으로 자연스럽게 치료합니다.</p>`
      },
      {
        heading: '충치 진행 단계별 치료',
        content: `<ul>
<li><strong>초기 충치 (법랑질)</strong> — 불소 도포 또는 실란트로 진행을 막습니다. 삭제 불필요</li>
<li><strong>중기 충치 (상아질)</strong> — 충치 부분만 제거 후 레진으로 자연스럽게 수복합니다</li>
<li><strong>깊은 충치 (신경 근접)</strong> — 신경 보존 치료 후 레진빌드업으로 원래 형태로 복원합니다</li>
<li><strong>심한 충치 (신경 감염)</strong> — 신경치료 후 크라운 또는 레진빌드업으로 수복합니다</li>
</ul>`
      },
      {
        heading: '레진 직접수복의 장점',
        content: `<p>서울가온치과에서는 가능한 경우 <strong>레진 직접수복</strong>을 우선 시행합니다:</p>
<ul>
<li><strong>당일 완료</strong> — 한 번의 내원으로 치료가 끝납니다</li>
<li><strong>자연치아색</strong> — 치아 색상과 동일한 레진으로 수복하여 자연스럽습니다</li>
<li><strong>최소 삭제</strong> — 충치 부분만 제거하므로 건강한 치아가 더 많이 남습니다</li>
<li><strong>합리적 비용</strong> — 인레이나 크라운에 비해 비용이 절약됩니다</li>
</ul>`
      }
    ],
    faqs: [
      { q: '충치치료 비용은 얼마인가요?', a: '충치치료는 대부분 건강보험이 적용됩니다. 레진수복의 경우 재료와 범위에 따라 차이가 있으며, 진료 전 정확한 비용을 안내드립니다.' },
      { q: '충치치료는 아프나요?', a: '충분한 마취 후 진행하므로 치료 중 통증은 거의 없습니다. 마취 주사도 최대한 부드럽게 시행합니다.' },
      { q: '충치를 오래 방치하면 어떻게 되나요?', a: '초기 충치는 레진으로 간단히 치료되지만, 방치하면 신경까지 감염되어 신경치료가 필요해지고, 최악의 경우 발치 후 임플란트가 필요할 수 있습니다. 빨리 치료할수록 치아를 더 많이 보존할 수 있습니다.' },
      { q: '아말감(은색 충전물)을 레진으로 교체할 수 있나요?', a: '네, 가능합니다. 서울가온치과에서는 오래된 아말감을 안전하게 제거하고 자연스러운 레진으로 교체해 드립니다.' },
    ],
    ctaText: '충치치료 상담 예약',
    relatedLinks: [
      { href: '/resin-buildup', label: '레진빌드업' },
      { href: '/endodontics', label: '의정부 신경치료' },
      { href: '/implant', label: '의정부 임플란트' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 7. 의정부 임플란트 잘하는곳 ──
  {
    slug: 'implant-best',
    title: '의정부 임플란트 잘하는곳 | 서울가온치과 — CT 가이드 수술, 서울대 출신',
    metaDesc: '의정부 임플란트 잘하는곳 찾으시나요? 서울가온치과는 CT 기반 가이드 임플란트로 정확하게, 최소 절개로 수술합니다. 서울대 출신 현진호 대표원장 직접 수술. 뼈이식·상악동거상술·전체임플란트 진료. ☎ 0507-1325-3377',
    h1: '의정부 임플란트 잘하는곳 — 어디서 받아야 할지 고민이신다면',
    heroSub: 'CT 가이드 수술로 정확하고 안전한 임플란트, 서울대 출신 대표원장 직접 수술',
    keywords: '의정부 임플란트 잘하는곳, 의정부 임플란트, 의정부 임플란트 추천, 의정부 임플란트 비용, 의정부 임플란트 가격, 탑석역 임플란트, 의정부 치과 임플란트, 의정부 임플란트 후기',
    category: '임플란트',
    sections: [
      {
        heading: '서울가온치과 임플란트, 왜 다를까요?',
        content: `<p>서울가온치과는 모든 임플란트 수술에 <strong>CT 기반 가이드 시스템</strong>을 적용합니다. 3D CT 촬영으로 잇몸뼈 상태를 정밀 분석한 뒤, 컴퓨터로 설계한 최적의 위치에 임플란트를 식립합니다.</p>
<p><strong>현진호 대표원장</strong>(서울대학교 치의학과 졸업)이 상담부터 수술, 보철까지 전 과정을 직접 책임집니다. 경기 북부 지역에서 <strong>전체임플란트, 뼈이식, 상악동거상술</strong>까지 원스톱으로 진행할 수 있는 치과의원입니다.</p>`
      },
      {
        heading: 'CT 가이드 임플란트의 장점',
        content: `<ul>
<li><strong>정확한 식립</strong> — 0.1mm 단위로 계획한 위치에 정확하게 식립하여 보철 결과가 우수합니다</li>
<li><strong>최소 절개</strong> — 잇몸을 크게 열지 않아 출혈·부종·통증이 적습니다</li>
<li><strong>빠른 회복</strong> — 무절개 또는 최소절개로 수술 후 일상 복귀가 빠릅니다</li>
<li><strong>신경·혈관 보호</strong> — CT로 해부학적 구조를 파악하여 안전합니다</li>
<li><strong>보철 최적화</strong> — 처음부터 보철 형태를 고려한 설계로 자연스러운 결과</li>
</ul>`
      },
      {
        heading: '임플란트 치료 과정',
        content: `<ol>
<li><strong>정밀 진단</strong> — 3D CT 촬영, 구강 검진, 전신 건강 상태 확인</li>
<li><strong>치료 계획</strong> — 디지털 설계로 최적의 임플란트 위치·각도·길이 결정</li>
<li><strong>가이드 수술</strong> — CT 가이드를 이용한 정밀 식립 (필요 시 뼈이식 동반)</li>
<li><strong>치유 기간</strong> — 약 3개월 뼈와 임플란트 결합 대기</li>
<li><strong>보철 완성</strong> — 맞춤 보철물 장착으로 자연스러운 치아 회복</li>
</ol>`
      },
      {
        heading: '만 65세 이상 임플란트 건강보험',
        content: `<p>만 65세 이상이시면 <strong>평생 2개까지 임플란트 건강보험</strong>이 적용됩니다. 본인부담금 약 30%로 합리적인 비용에 임플란트 치료를 받으실 수 있습니다. 서울가온치과에서 보험 적용 여부를 확인해 드립니다.</p>`
      }
    ],
    faqs: [
      { q: '임플란트 수술은 아프나요?', a: '충분한 마취 후 진행하므로 수술 중 통증은 거의 없습니다. CT 가이드를 사용하면 절개를 최소화하여 수술 후 부종과 통증도 크게 줄어듭니다.' },
      { q: '임플란트 비용은 얼마인가요?', a: '임플란트 비용은 뼈 상태, 뼈이식 필요 여부, 보철 종류에 따라 달라집니다. 정확한 비용은 CT 촬영 후 상담 시 안내해 드립니다. 만 65세 이상은 건강보험 적용이 가능합니다.' },
      { q: '뼈가 부족해도 임플란트가 가능한가요?', a: '네, 서울가온치과는 뼈이식과 상악동거상술을 전문적으로 시행합니다. 다른 치과에서 어렵다고 한 경우도 상담해 주세요.' },
      { q: '임플란트 수명은 얼마나 되나요?', a: '적절한 관리 시 20년 이상 사용 가능합니다. 정기 검진과 올바른 구강 위생 관리가 중요합니다.' },
    ],
    ctaText: '임플란트 상담 예약하기',
    relatedLinks: [
      { href: '/implant', label: '임플란트 상세 안내' },
      { href: '/implant-process', label: '임플란트 과정 안내' },
      { href: '/implant-cost', label: '임플란트 비용 안내' },
      { href: '/full-mouth-implant', label: '전체 임플란트' },
      { href: '/before-after', label: '임플란트 전후 사례' },
    ]
  },
  // ── 8. 의정부 전체 임플란트 ──
  {
    slug: 'full-mouth-implant',
    title: '의정부 전체임플란트 | 서울가온치과 — 위아래 전악 임플란트',
    metaDesc: '의정부 전체임플란트(전악임플란트) 전문 서울가온치과. 틀니에서 임플란트로, 위아래 전체 임플란트까지. CT 가이드 수술로 정확한 식립. 현진호 대표원장 직접 수술. 82건+ 전체임플란트 실적. ☎ 0507-1325-3377',
    h1: '의정부 전체임플란트 — 이가 거의 남지 않으셔도 가능합니다',
    heroSub: '틀니에서 임플란트로, 위아래 전악 임플란트까지 원스톱 치료',
    keywords: '의정부 전체임플란트, 의정부 전악임플란트, 의정부 전체 임플란트 비용, 의정부 틀니 임플란트, 전체 임플란트 잘하는곳, 의정부 위아래 임플란트, 탑석역 전체임플란트',
    category: '전체임플란트',
    sections: [
      {
        heading: '서울가온치과 전체임플란트 진료 역량',
        content: `<p>서울가온치과 현진호 대표원장은 <strong>전체임플란트(전악임플란트) 82건 이상</strong>의 풍부한 수술 경험을 보유하고 있습니다. 오랜 기간 틀니를 사용해오신 분, 치주염으로 치아가 거의 남지 않은 분들에게 <strong>임플란트로 새로운 치아</strong>를 만들어 드립니다.</p>
<p>CT 기반 가이드 시스템으로 다수의 임플란트를 정확한 위치에 식립하고, 필요한 경우 <strong>상악동거상술·뼈이식</strong>을 동반하여 부족한 잇몸뼈를 보강합니다.</p>`
      },
      {
        heading: '전체임플란트가 필요한 경우',
        content: `<ul>
<li><strong>틀니가 불편한 분</strong> — 잘 씹히지 않거나 자꾸 빠지는 틀니를 고정식 임플란트로 교체</li>
<li><strong>치주염으로 치아가 흔들리는 분</strong> — 심한 잇몸병으로 대부분의 치아를 살릴 수 없는 경우</li>
<li><strong>오래된 보철이 망가진 분</strong> — 브릿지 뿌리 파절, 크라운 하방 충치 등으로 재치료가 불가한 경우</li>
<li><strong>치아가 거의 남지 않은 분</strong> — 윗턱 또는 아래턱에 치아가 몇 개 남지 않은 경우</li>
</ul>`
      },
      {
        heading: '서울가온치과 전체임플란트 과정',
        content: `<ol>
<li><strong>정밀 진단</strong> — 3D CT·파노라마·구강 스캔으로 잇몸뼈 상태 정밀 분석</li>
<li><strong>디지털 설계</strong> — 최적의 임플란트 개수·위치·보철 형태를 컴퓨터로 설계</li>
<li><strong>1차 수술</strong> — CT 가이드로 임플란트 식립 + 필요 시 뼈이식·상악동거상술</li>
<li><strong>치유 기간</strong> — 약 3~6개월 뼈와 임플란트 결합 대기 (임시치아 사용 가능)</li>
<li><strong>보철 완성</strong> — 맞춤 보철물 장착, 교합 조정으로 마무리</li>
</ol>`
      }
    ],
    faqs: [
      { q: '전체임플란트 비용은 얼마인가요?', a: '임플란트 개수, 뼈이식 범위, 보철 종류에 따라 달라집니다. 일반적으로 한쪽(위 또는 아래) 전체임플란트는 CT 촬영 후 정확한 견적을 안내드립니다.' },
      { q: '고령인데 전체임플란트가 가능한가요?', a: '네, 서울가온치과에서는 70~80대 환자분들도 안전하게 전체임플란트를 진행하고 있습니다. 전신 건강 상태를 확인하고, 복용 중인 약물을 검토한 뒤 수술 여부를 판단합니다.' },
      { q: '틀니를 쓰다가 임플란트로 바꿀 수 있나요?', a: '네, 가능합니다. 오래 틀니를 사용하면 잇몸뼈가 흡수되어 있을 수 있는데, 뼈이식과 상악동거상술로 보강한 뒤 임플란트를 식립합니다.' },
      { q: '수술 중 치아 없이 지내야 하나요?', a: '아닙니다. 치유 기간 동안 임시치아(임시틀니)를 착용하실 수 있어 일상생활에 큰 불편 없이 지내실 수 있습니다.' },
    ],
    ctaText: '전체임플란트 상담 예약',
    relatedLinks: [
      { href: '/implant', label: '임플란트 상세 안내' },
      { href: '/implant-best', label: '임플란트 잘하는곳' },
      { href: '/bone-graft-implant', label: '뼈이식 임플란트' },
      { href: '/before-after', label: '전후 사례 보기' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 9. 의정부 앞니 임플란트 ──
  {
    slug: 'front-tooth-implant',
    title: '의정부 앞니임플란트 | 서울가온치과 — 심미적 앞니 복원',
    metaDesc: '의정부 앞니임플란트 서울가온치과. 앞니는 심미성이 특히 중요합니다. CT 가이드 수술로 정확한 위치에 식립, PFZ 보철로 자연스러운 앞니를 완성합니다. 현진호 대표원장 직접 수술. ☎ 0507-1325-3377',
    h1: '의정부 앞니임플란트 — 자연스러운 심미 복원',
    heroSub: '앞니는 얼굴의 인상을 결정합니다. CT 가이드 + PFZ 보철로 자연스럽게',
    keywords: '의정부 앞니 임플란트, 의정부 앞니 치료, 앞니 임플란트 비용, 앞니 임플란트 후기, 의정부 앞니 보철, 앞니 깨짐, 앞니 부러짐, 앞니 크라운',
    category: '앞니임플란트',
    sections: [
      {
        heading: '앞니 임플란트, 왜 정밀한 진료가 중요한가요?',
        content: `<p>앞니는 단순히 씹는 기능뿐 아니라 <strong>얼굴의 인상과 미소</strong>를 결정하는 중요한 치아입니다. 앞니 임플란트는 일반 어금니 임플란트와 달리 <strong>잇몸 라인, 치아 형태, 색상, 투명도</strong>까지 세밀하게 고려해야 합니다.</p>
<p>서울가온치과 현진호 대표원장은 앞니 임플란트에서 <strong>CT 가이드 수술</strong>로 보철에 최적화된 위치에 식립하고, <strong>PFZ(Porcelain Fused to Zirconia) 보철</strong>로 반대편 자연치아와 구분이 안 되는 결과를 만들어냅니다.</p>`
      },
      {
        heading: '앞니 치료가 필요한 상황',
        content: `<ul>
<li><strong>외상으로 앞니 파절</strong> — 넘어지거나 부딪혀서 앞니가 깨지거나 부러진 경우</li>
<li><strong>치주염으로 앞니 흔들림</strong> — 잇몸뼈가 녹아 앞니가 흔들리는 경우</li>
<li><strong>오래된 앞니 브릿지</strong> — 기존 보철물이 떨어지거나 하방 치아 뿌리가 파절된 경우</li>
<li><strong>앞니 심한 충치</strong> — 신경치료로도 살리기 어려운 심한 충치</li>
</ul>`
      },
      {
        heading: '앞니 임플란트 결과 — 실제 사례',
        content: `<p>서울가온치과에서는 다양한 앞니 임플란트 사례를 <strong>비포&amp;애프터</strong>로 공개하고 있습니다. 젊은 여성 환자분부터 70대 환자분까지, 앞니 1개부터 여러 개까지 — 모두 자연스러운 결과를 확인하실 수 있습니다.</p>
<p>👉 <a href="/before-after"><strong>앞니 임플란트 비포&amp;애프터 보기</strong></a></p>`
      }
    ],
    faqs: [
      { q: '앞니 임플란트 비용은 얼마인가요?', a: '앞니 임플란트는 심미 보철(PFZ)이 필요하므로 어금니보다 비용이 다소 높을 수 있습니다. 정확한 비용은 진단 후 안내드립니다.' },
      { q: '앞니 임플란트 치료기간은 얼마나 걸리나요?', a: '수술 후 약 3개월의 치유 기간이 필요하며, 이 기간 동안 임시치아를 착용하여 심미성을 유지합니다. 전체 과정은 약 4~6개월입니다.' },
      { q: '앞니 임플란트가 티가 나지 않나요?', a: 'PFZ 보철은 자연치아와 거의 동일한 투명도와 색상을 재현합니다. 반대편 자연치아와 구분이 어려울 정도로 자연스럽습니다.' },
    ],
    ctaText: '앞니 임플란트 상담 예약',
    relatedLinks: [
      { href: '/implant', label: '임플란트 상세 안내' },
      { href: '/aesthetic', label: '앞니 심미치료' },
      { href: '/before-after', label: '전후 사례 보기' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 10. 의정부 뼈이식 임플란트 ──
  {
    slug: 'bone-graft-implant',
    title: '의정부 뼈이식 임플란트 | 서울가온치과 — 상악동거상술·뼈이식',
    metaDesc: '의정부 뼈이식 임플란트 서울가온치과. 잇몸뼈가 부족해 다른 치과에서 안 된다고 하셨나요? 상악동거상술·수직골증강까지. 현진호 대표원장(서울대) 직접 수술. ☎ 0507-1325-3377',
    h1: '의정부 뼈이식 임플란트 — 뼈가 부족해도 가능합니다',
    heroSub: '다른 치과에서 안 된다고 하셨나요? 상악동거상술·뼈이식으로 가능하게 만듭니다',
    keywords: '의정부 뼈이식 임플란트, 의정부 상악동거상술, 뼈이식 임플란트 비용, 임플란트 뼈이식, 의정부 뼈이식, 뼈 부족 임플란트, 수직골증강, 잇몸뼈 이식',
    category: '뼈이식임플란트',
    sections: [
      {
        heading: '뼈이식, 왜 필요한가요?',
        content: `<p>임플란트를 식립하려면 충분한 <strong>잇몸뼈(치조골)</strong>가 있어야 합니다. 하지만 오래 전에 치아를 잃었거나, 치주염으로 뼈가 녹았거나, 윗턱 부위의 상악동이 가까운 경우 뼈가 부족할 수 있습니다.</p>
<p>서울가온치과는 <strong>뼈이식과 상악동거상술</strong>을 전문적으로 시행하여, 다른 치과에서 임플란트가 어렵다고 진단받으신 분들도 안전하게 임플란트 치료를 받으실 수 있습니다.</p>`
      },
      {
        heading: '뼈이식·상악동거상술 종류',
        content: `<ul>
<li><strong>상악동거상술(Sinus Lift)</strong> — 윗턱 어금니 부위의 상악동 점막을 올리고 뼈이식재를 채워 임플란트 식립 공간을 확보합니다</li>
<li><strong>골유도재생술(GBR)</strong> — 부족한 부위에 뼈이식재와 차폐막을 적용하여 뼈를 재생시킵니다</li>
<li><strong>수직골증강(Vertical Augmentation)</strong> — 뼈 높이가 심하게 부족한 경우 수직으로 뼈를 증강합니다 (고난도 수술)</li>
<li><strong>블록골이식</strong> — 자가골이나 동종골 블록을 이식하여 넓은 범위의 뼈를 보강합니다</li>
</ul>`
      },
      {
        heading: '서울가온치과 뼈이식 실력',
        content: `<p>현진호 대표원장은 <strong>상악동거상술과 뼈이식을 동반한 임플란트 수술</strong>에 풍부한 경험을 보유하고 있습니다. 실제로 "뼈가 종잇장처럼 얇은" 상태에서도 상악동거상술을 성공적으로 시행한 사례, 80대 고령 환자분의 전체임플란트까지 다양한 난이도의 수술을 진행하고 있습니다.</p>
<p>👉 <a href="/before-after"><strong>뼈이식 임플란트 사례 보기</strong></a></p>`
      }
    ],
    faqs: [
      { q: '뼈이식하면 아프나요?', a: '수술 중에는 마취로 통증이 없고, 수술 후 2~3일 정도 부종이 있을 수 있으나 처방 약으로 관리 가능합니다.' },
      { q: '뼈이식 비용은 얼마인가요?', a: '뼈이식 범위와 사용하는 이식재에 따라 달라집니다. CT 촬영 후 정확한 비용을 안내드립니다.' },
      { q: '다른 치과에서 뼈가 없어 안 된다고 했는데 가능한가요?', a: '상악동거상술, 수직골증강 등 다양한 뼈이식 방법이 있습니다. 서울가온치과에서 CT를 촬영하고 정밀 진단 후 가능 여부를 판단해 드립니다.' },
    ],
    ctaText: '뼈이식 임플란트 상담 예약',
    relatedLinks: [
      { href: '/implant', label: '임플란트 상세 안내' },
      { href: '/full-mouth-implant', label: '전체 임플란트' },
      { href: '/implant-best', label: '임플란트 잘하는곳' },
      { href: '/before-after', label: '전후 사례 보기' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 11. 의정부 라미네이트 ──
  {
    slug: 'laminate',
    title: '의정부 라미네이트 | 서울가온치과 — 최소삭제 심미보철, 자연스러운 앞니',
    metaDesc: '의정부 라미네이트 서울가온치과. 앞니 변색·벌어짐·왜소치를 최소삭제 라미네이트로 자연스럽게 개선합니다. 디지털 쉐이드 매칭. 무삭제 라미네이트 시술 가능. ☎ 0507-1325-3377',
    h1: '의정부 라미네이트 — 최소삭제로 자연스러운 앞니',
    heroSub: '변색·벌어짐·왜소치, 라미네이트로 자연스럽게 개선합니다',
    keywords: '의정부 라미네이트, 의정부 라미네이트 비용, 의정부 앞니 라미네이트, 라미네이트 가격, 의정부 심미치료, 탑석역 라미네이트, 의정부 치아성형',
    category: '라미네이트',
    sections: [
      {
        heading: '라미네이트란?',
        content: `<p>라미네이트는 앞니 표면을 <strong>최소한으로 삭제</strong>한 뒤, 얇은 도자기(세라믹) 쉘을 부착하여 <strong>치아의 형태·색상·크기</strong>를 개선하는 심미치료입니다. 네일아트처럼 얇은 보철물을 붙인다고 생각하시면 됩니다.</p>
<p>서울가온치과에서는 치아 삭제를 더욱 줄인 <strong>최소삭제·무삭제 라미네이트</strong> 시술도 가능합니다.</p>`
      },
      {
        heading: '라미네이트가 적합한 경우',
        content: `<ul>
<li><strong>앞니 변색</strong> — 미백으로 개선되지 않는 심한 변색</li>
<li><strong>앞니 벌어짐</strong> — 치아 사이 벌어진 틈(이개)</li>
<li><strong>왜소치</strong> — 작은 앞니를 정상 크기로 개선</li>
<li><strong>치아 형태 불만</strong> — 울퉁불퉁하거나 비대칭인 앞니</li>
<li><strong>미세 파절</strong> — 앞니 끝이 살짝 깨진 경우</li>
</ul>`
      },
      {
        heading: '라미네이트 vs 올세라믹 크라운 vs 최소삭제 라미네이트',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:8px;border:1px solid #ddd">구분</th><th style="padding:8px;border:1px solid #ddd">치아삭제량</th><th style="padding:8px;border:1px solid #ddd">적합한 경우</th></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>라미네이트</strong></td><td style="padding:8px;border:1px solid #ddd">앞면 최소 삭제</td><td style="padding:8px;border:1px solid #ddd">변색, 형태개선</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>최소삭제 라미네이트</strong></td><td style="padding:8px;border:1px solid #ddd">거의 무삭제</td><td style="padding:8px;border:1px solid #ddd">왜소치, 경미한 벌어짐</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>올세라믹 크라운</strong></td><td style="padding:8px;border:1px solid #ddd">전체 삭제</td><td style="padding:8px;border:1px solid #ddd">심한 손상, 신경치료 후</td></tr>
</table>`
      }
    ],
    faqs: [
      { q: '라미네이트 수명은 얼마나 되나요?', a: '일반적으로 10~15년 이상 사용 가능합니다. 딱딱한 음식을 직접 씹는 습관을 피하면 더 오래 유지됩니다.' },
      { q: '라미네이트 시술 후 아프나요?', a: '치아 삭제량이 적어 시술 후 시림이나 통증은 거의 없습니다. 일상생활에 바로 복귀 가능합니다.' },
      { q: '최소삭제 라미네이트는 일반 라미네이트와 뭔가 다른가요?', a: '최소삭제 방식은 치아 삭제를 거의 하지 않는 방식입니다. 치아 상태에 따라 적합한 방법을 안내드립니다.' },
    ],
    ctaText: '라미네이트 상담 예약',
    relatedLinks: [
      { href: '/aesthetic', label: '앞니 심미치료' },
      { href: '/front-tooth-implant', label: '앞니 임플란트' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 12. 의정부 사랑니 발치 ──
  {
    slug: 'wisdom-tooth',
    title: '의정부 사랑니 발치 | 서울가온치과 — 안전한 매복 사랑니 발치',
    metaDesc: '의정부 사랑니 발치 서울가온치과. 매복사랑니, 누운사랑니도 안전하게. CT 촬영으로 신경관 위치 확인 후 발치. 당일 발치 가능. 건강보험 적용. 탑석역 5분. ☎ 0507-1325-3377',
    h1: '의정부 사랑니 발치 — 안전하고 빠르게',
    heroSub: '매복사랑니, 누운사랑니도 CT 확인 후 안전하게 발치합니다',
    keywords: '의정부 사랑니, 의정부 사랑니 발치, 의정부 매복사랑니, 사랑니 발치 비용, 의정부 치과 사랑니, 탑석역 사랑니, 사랑니 통증, 누운사랑니 발치',
    category: '사랑니발치',
    sections: [
      {
        heading: '사랑니, 꼭 빼야 하나요?',
        content: `<p>모든 사랑니를 뽑아야 하는 것은 아닙니다. 하지만 아래와 같은 경우에는 발치가 권장됩니다:</p>
<ul>
<li><strong>매복(묻힌) 사랑니</strong> — 뼈 속에 묻혀 주변 조직에 압력을 가하거나 낭종이 생길 위험</li>
<li><strong>누운 사랑니</strong> — 옆으로 누워 앞 치아를 밀거나, 앞 치아에 충치를 유발</li>
<li><strong>반복적 염증</strong> — 잇몸이 자주 붓고 아픈 경우 (지치주위염)</li>
<li><strong>충치 발생</strong> — 사랑니 자체에 충치가 생겼거나, 앞 치아에 충치를 유발하는 경우</li>
</ul>`
      },
      {
        heading: '서울가온치과의 안전한 사랑니 발치',
        content: `<p>서울가온치과에서는 사랑니 발치 전 반드시 <strong>CT 촬영</strong>을 통해 사랑니의 위치, 뿌리 형태, <strong>하치조신경관과의 거리</strong>를 정확히 파악합니다. 이를 통해 신경 손상 없이 안전하게 발치합니다.</p>
<p>간단한 사랑니는 <strong>당일 발치</strong>가 가능하며, 매복사랑니도 풍부한 경험을 바탕으로 빠르고 정확하게 발치합니다.</p>`
      }
    ],
    faqs: [
      { q: '사랑니 발치 비용은 얼마인가요?', a: '사랑니 발치는 건강보험이 적용됩니다. 단순 발치는 1~2만원대, 매복사랑니는 난이도에 따라 3~5만원대입니다 (본인부담금 기준).' },
      { q: '사랑니 발치 후 많이 아프나요?', a: '수술 중에는 마취로 통증이 없습니다. 발치 후 2~3일 정도 부종이 있을 수 있으나, 처방 약으로 관리 가능합니다.' },
      { q: '사랑니 4개를 한번에 뽑을 수 있나요?', a: '환자분의 건강 상태와 사랑니 난이도에 따라 다릅니다. 일반적으로 한쪽(왼쪽 2개 또는 오른쪽 2개)씩 진행하는 것을 권장합니다.' },
    ],
    ctaText: '사랑니 상담 예약',
    relatedLinks: [
      { href: '/implant', label: '의정부 임플란트' },
      { href: '/cavity-treatment', label: '의정부 충치치료' },
      { href: '/uijeongbu-dental', label: '의정부 치과 추천' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 13. 의정부 스케일링·잇몸치료 ──
  {
    slug: 'scaling-gum-treatment',
    title: '의정부 스케일링·잇몸치료 | 서울가온치과 — 치주염 예방과 치료',
    metaDesc: '의정부 스케일링·잇몸치료 서울가온치과. 연 1회 건강보험 스케일링, 치주염(풍치) 진단 및 치료. 잇몸 출혈·구취·치아 흔들림 증상이 있다면 빠른 치료가 중요합니다. ☎ 0507-1325-3377',
    h1: '의정부 스케일링·잇몸치료 — 건강한 잇몸이 건강한 치아의 시작',
    heroSub: '연 1회 보험 스케일링 + 치주염 전문 치료',
    keywords: '의정부 스케일링, 의정부 잇몸치료, 의정부 치주치료, 잇몸 출혈, 치주염, 풍치, 의정부 잇몸병, 탑석역 스케일링, 스케일링 비용, 잇몸이 아파요',
    category: '스케일링·잇몸치료',
    sections: [
      {
        heading: '스케일링, 왜 정기적으로 받아야 하나요?',
        content: `<p><strong>치석</strong>은 칫솔질로 제거할 수 없는 단단한 세균 덩어리입니다. 치석이 쌓이면 잇몸에 염증이 생기고(치은염), 방치하면 잇몸뼈까지 녹는 <strong>치주염(풍치)</strong>으로 진행됩니다. 치주염은 치아를 잃는 가장 큰 원인입니다.</p>
<p>만 19세 이상이면 <strong>연 1회 건강보험 적용</strong>으로 스케일링을 받을 수 있습니다.</p>`
      },
      {
        heading: '이런 증상이 있다면 잇몸치료가 필요합니다',
        content: `<ul>
<li><strong>칫솔질할 때 잇몸에서 피가 나요</strong></li>
<li><strong>잇몸이 부어오르고 빨갛게 변했어요</strong></li>
<li><strong>입에서 냄새가 나요</strong> (구취)</li>
<li><strong>치아가 예전보다 길어 보여요</strong> (잇몸 퇴축)</li>
<li><strong>치아가 흔들려요</strong></li>
<li><strong>씹을 때 잇몸이 아파요</strong></li>
</ul>`
      },
      {
        heading: '서울가온치과 잇몸치료 과정',
        content: `<ol>
<li><strong>정밀 검진</strong> — 잇몸 상태 확인, 치주낭 깊이 측정, 필요 시 X-ray 촬영</li>
<li><strong>스케일링</strong> — 치석 및 치태 제거 (보험 적용)</li>
<li><strong>치근활택술(SRP)</strong> — 잇몸 아래 깊은 곳의 치석과 감염 조직 제거 (중등도 치주염)</li>
<li><strong>치주 수술</strong> — 심한 치주염의 경우 잇몸을 열어 깊은 치석을 제거하고 뼈이식 (중증)</li>
<li><strong>정기 관리</strong> — 3~6개월마다 정기 점검으로 재발 방지</li>
</ol>`
      }
    ],
    faqs: [
      { q: '스케일링 비용은 얼마인가요?', a: '만 19세 이상이면 연 1회 건강보험이 적용되어 본인부담금 약 1만 5천원 정도입니다.' },
      { q: '스케일링 후 이가 시릴 수 있나요?', a: '치석이 제거되면 일시적으로 시림이 있을 수 있으나, 보통 1~2주 내에 자연히 사라집니다.' },
      { q: '치주염은 완치가 되나요?', a: '치주염은 완치보다는 관리의 개념입니다. 적절한 치료 후 정기적인 스케일링과 관리로 진행을 멈출 수 있습니다.' },
    ],
    ctaText: '스케일링·잇몸치료 예약',
    relatedLinks: [
      { href: '/implant', label: '의정부 임플란트' },
      { href: '/cavity-treatment', label: '의정부 충치치료' },
      { href: '/uijeongbu-dental', label: '의정부 치과 추천' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 14. 의정부 틀니 임플란트 ──
  {
    slug: 'denture-to-implant',
    title: '의정부 틀니임플란트 | 서울가온치과 — 틀니에서 임플란트로 전환',
    metaDesc: '의정부 틀니임플란트 서울가온치과. 불편한 틀니를 고정식 임플란트로 교체하세요. 전체틀니에서 전체임플란트까지. 만 65세 이상 건강보험 적용. 현진호 대표원장 직접 수술. ☎ 0507-1325-3377',
    h1: '의정부 틀니임플란트 — 불편한 틀니에서 든든한 임플란트로',
    heroSub: '틀니의 불편함을 끝내세요. 고정식 임플란트로 자신 있게 드세요',
    keywords: '의정부 틀니 임플란트, 틀니에서 임플란트, 의정부 틀니, 전체틀니 임플란트, 임플란트 틀니 비용, 만 65세 임플란트, 노인 임플란트, 고령 임플란트',
    category: '틀니임플란트',
    sections: [
      {
        heading: '틀니가 불편하신가요?',
        content: `<p>틀니는 시간이 지나면서 <strong>잇몸뼈가 흡수</strong>되어 맞지 않게 되고, 음식을 씹기 어렵고, 빠질까 불안하고, 대화 시 불편함이 생깁니다. 임플란트는 이런 틀니의 불편함을 근본적으로 해결합니다.</p>
<p>서울가온치과에서는 <strong>틀니에서 임플란트로의 전환</strong>을 전문적으로 진행합니다. 오래 틀니를 사용해 잇몸뼈가 부족한 경우에도 뼈이식과 상악동거상술로 가능하게 만듭니다.</p>`
      },
      {
        heading: '틀니 vs 임플란트 비교',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:8px;border:1px solid #ddd">구분</th><th style="padding:8px;border:1px solid #ddd">틀니</th><th style="padding:8px;border:1px solid #ddd">임플란트</th></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>저작력</strong></td><td style="padding:8px;border:1px solid #ddd">자연치아의 20~30%</td><td style="padding:8px;border:1px solid #ddd">자연치아의 80~90%</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>안정성</strong></td><td style="padding:8px;border:1px solid #ddd">움직임·탈락 가능</td><td style="padding:8px;border:1px solid #ddd">뼈에 고정, 움직이지 않음</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>관리</strong></td><td style="padding:8px;border:1px solid #ddd">매일 세척 필요</td><td style="padding:8px;border:1px solid #ddd">자연치아처럼 양치</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>수명</strong></td><td style="padding:8px;border:1px solid #ddd">5~7년마다 교체</td><td style="padding:8px;border:1px solid #ddd">20년 이상</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>보험</strong></td><td style="padding:8px;border:1px solid #ddd">건강보험 적용</td><td style="padding:8px;border:1px solid #ddd">만 65세 이상 2개 보험</td></tr>
</table>`
      },
      {
        heading: '만 65세 이상 임플란트 건강보험',
        content: `<p>만 65세 이상이시면 <strong>평생 2개까지 임플란트 건강보험</strong>이 적용됩니다 (본인부담금 약 30%). 임플란트 보험 적용과 함께, 추가 비용으로 더 많은 임플란트를 식립하여 편안한 식사를 되찾으실 수 있습니다.</p>`
      }
    ],
    faqs: [
      { q: '틀니를 오래 써서 뼈가 많이 녹았는데 임플란트가 되나요?', a: '네, 뼈이식과 상악동거상술로 부족한 뼈를 보강한 뒤 임플란트를 식립합니다. 서울가온치과에서는 다수의 동일 사례를 성공적으로 치료하고 있습니다.' },
      { q: '80세인데 수술이 가능한가요?', a: '전신 건강 상태와 복용 약물을 면밀히 확인한 뒤 수술 여부를 판단합니다. 서울가온치과에서는 70~80대 환자분들도 안전하게 전체임플란트를 진행하고 있습니다.' },
      { q: '임플란트 하는 동안 치아 없이 지내야 하나요?', a: '치유 기간 동안 임시틀니를 착용하실 수 있어 일상생활에 큰 불편이 없습니다.' },
    ],
    ctaText: '틀니→임플란트 상담 예약',
    relatedLinks: [
      { href: '/full-mouth-implant', label: '전체 임플란트' },
      { href: '/implant', label: '임플란트 상세 안내' },
      { href: '/bone-graft-implant', label: '뼈이식 임플란트' },
      { href: '/before-after', label: '전후 사례 보기' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 15. 의정부 임플란트 가격/비용 ──
  {
    slug: 'implant-cost',
    title: '의정부 임플란트 가격 비용 | 서울가온치과 — 합리적 임플란트 비용 안내',
    metaDesc: '의정부 임플란트 가격이 궁금하세요? 서울가온치과 임플란트 비용 투명 안내. 건강보험 임플란트 본인부담금 약 30만원. 비보험 임플란트도 합리적 가격. 무이자 할부 가능. 현진호 대표원장 직접 수술. ☎ 0507-1325-3377',
    h1: '의정부 임플란트 가격 — 투명하고 합리적인 비용 안내',
    heroSub: '감추지 않는 가격, 믿을 수 있는 진료. 서울가온치과 임플란트 비용을 확인하세요',
    keywords: '의정부 임플란트 가격, 의정부 임플란트 비용, 임플란트 가격, 임플란트 비용, 저렴한 임플란트, 임플란트 보험 가격, 임플란트 할부, 의정부 임플란트 싼 곳',
    category: '임플란트 비용',
    sections: [
      {
        heading: '임플란트 가격, 왜 병원마다 다를까요?',
        content: `<p>임플란트 가격은 <strong>사용하는 임플란트 브랜드(픽스쳐)</strong>, <strong>보철물(크라운) 재질</strong>, <strong>수술 난이도(뼈이식 여부)</strong>, 그리고 <strong>의료진의 전문성과 경험</strong>에 따라 달라집니다.</p>
<p>서울가온치과는 <strong>"가격은 합리적으로, 품질은 타협 없이"</strong>를 원칙으로 합니다. 세계적으로 검증된 임플란트 브랜드만 사용하고, 저가형 임플란트로 가격을 낮추는 방식은 절대 하지 않습니다.</p>
<p>⚕️ 사용 브랜드: <strong>오스템(Osstem), 스트라우만(Straumann), 네오(NeoBiotech)</strong> — 글로벌 점유율 1~3위</p>`
      },
      {
        heading: '서울가온치과 임플란트 비용 가이드',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">항목</th><th style="padding:10px;border:1px solid #ddd">비용 (1개 기준)</th><th style="padding:10px;border:1px solid #ddd">비고</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>건강보험 임플란트</strong><br>(만 65세 이상)</td><td style="padding:10px;border:1px solid #ddd">본인부담금 약 <strong>30만원대</strong></td><td style="padding:10px;border:1px solid #ddd">평생 2개 / 위·아래 각 1개</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>일반 임플란트</strong></td><td style="padding:10px;border:1px solid #ddd"><strong>상담 후 안내</strong></td><td style="padding:10px;border:1px solid #ddd">브랜드·보철 재질에 따라 상이</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>뼈이식 동반 시</strong></td><td style="padding:10px;border:1px solid #ddd"><strong>별도 추가</strong></td><td style="padding:10px;border:1px solid #ddd">뼈 부족 정도에 따라 상이</td></tr>
</table>
<p><strong>💳 무이자 할부 가능</strong> — 경제적 부담을 줄이고 필요한 치료를 미루지 마세요.</p>
<p>📋 정확한 비용은 CT 촬영 후 맞춤 치료 계획과 함께 안내드립니다. <strong>상담은 무료</strong>이며, 추가 비용 없이 치료 계획서를 받아보실 수 있습니다.</p>`
      },
      {
        heading: '싼 임플란트가 위험한 이유',
        content: `<p>"임플란트 1개 29만원" 같은 초저가 광고를 보셨나요? <strong>가격이 비정상적으로 낮은 경우</strong> 다음을 확인하세요:</p>
<ul>
<li><strong>검증되지 않은 브랜드</strong> — 임상 데이터가 부족한 저가형 픽스쳐 사용</li>
<li><strong>보철물 별도</strong> — 픽스쳐 가격만 표시, 크라운·지대주 비용 추가</li>
<li><strong>뼈이식 별도</strong> — 기본 가격에 포함되지 않는 숨은 비용</li>
<li><strong>전문의가 아닌 시술</strong> — 경력 부족 의사의 수술</li>
</ul>
<p>서울가온치과는 <strong>모든 비용을 사전에 투명하게 안내</strong>하며, 현진호 대표원장이 모든 수술을 직접 진행합니다.</p>`
      }
    ],
    faqs: [
      { q: '의정부에서 임플란트 가격이 가장 저렴한 곳은 어디인가요?', a: '단순히 가격이 낮은 것보다 사용하는 브랜드, 보철 재질, 의료진 경험을 함께 비교하는 것이 중요합니다. 서울가온치과는 세계 1~3위 브랜드만 사용하면서도 합리적 가격을 유지합니다.' },
      { q: '임플란트 1개 비용에 뭐가 포함되나요?', a: '일반적으로 픽스쳐(나사), 지대주(연결부), 크라운(보철)이 포함됩니다. 서울가온치과는 상담 시 CT 촬영 후 뼈이식 포함 여부까지 전체 비용을 투명하게 안내드립니다.' },
      { q: '만 65세 이상 건강보험 임플란트 조건이 뭔가요?', a: '만 65세 이상이면 평생 2개까지 건강보험이 적용됩니다 (본인부담금 약 30%). 위·아래 각 1개씩 가능하며, 무치악이 아니더라도 발치 후 적용 가능합니다.' },
      { q: '임플란트 무이자 할부가 되나요?', a: '네, 서울가온치과에서는 카드 무이자 할부를 지원합니다. 경제적 부담 없이 치료를 진행하실 수 있도록 다양한 결제 방법을 안내드립니다.' },
    ],
    ctaText: '임플란트 비용 무료 상담',
    relatedLinks: [
      { href: '/implant', label: '임플란트 상세 안내' },
      { href: '/implant-best', label: '의정부 임플란트 잘하는 곳' },
      { href: '/senior-implant', label: '노인 임플란트' },
      { href: '/bone-graft-implant', label: '뼈이식 임플란트' },
      { href: '/before-after', label: '전후 사례 보기' },
    ]
  },
  // ── 16. 의정부 야간진료 치과 ──
  {
    slug: 'night-dental',
    title: '의정부 야간진료 치과 | 서울가온치과 — 목요일 밤 8시 30분까지',
    metaDesc: '의정부 야간진료 치과 서울가온치과. 매주 목요일 밤 8시 30분까지 야간진료. 직장인·학생도 퇴근 후 내원 가능. 임플란트·교정·충치치료 등 전 진료과목 저녁 진료. 탑석역 도보 5분. ☎ 0507-1325-3377',
    h1: '의정부 야간진료 치과 — 목요일 밤 8시 30분까지',
    heroSub: '바쁜 일상에도 치과 진료를 미루지 마세요. 매주 목요일 야간진료 운영합니다',
    keywords: '의정부 야간진료 치과, 의정부 저녁 진료 치과, 의정부 늦게까지 하는 치과, 야간 치과, 퇴근 후 치과, 의정부 목요일 야간 치과, 저녁 치과 진료',
    category: '야간진료',
    sections: [
      {
        heading: '왜 야간진료 치과가 필요한가요?',
        content: `<p>직장인, 학생, 육아로 바쁜 분들은 <strong>평일 낮 시간에 치과를 방문하기 어렵습니다</strong>. 그래서 치과 치료를 계속 미루게 되고, 작은 충치가 신경치료로, 살릴 수 있던 치아가 발치로 이어지는 경우가 많습니다.</p>
<p>서울가온치과는 <strong>매주 목요일 밤 8시 30분(20:30)까지</strong> 야간진료를 운영합니다. 퇴근 후 7시, 7시 30분에 오셔도 충분히 진료 받으실 수 있습니다.</p>`
      },
      {
        heading: '서울가온치과 진료시간 안내',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">요일</th><th style="padding:10px;border:1px solid #ddd">진료시간</th><th style="padding:10px;border:1px solid #ddd">비고</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>월·화·수·금</strong></td><td style="padding:10px;border:1px solid #ddd">09:30 ~ <strong>18:30</strong></td><td style="padding:10px;border:1px solid #ddd">점심시간 12:30~14:00</td></tr>
<tr style="background:#fff8e8"><td style="padding:10px;border:1px solid #ddd"><strong>🌙 목요일</strong></td><td style="padding:10px;border:1px solid #ddd">09:30 ~ <strong style="color:#BFA46A;font-size:1.1em">20:30</strong></td><td style="padding:10px;border:1px solid #ddd"><strong>야간진료</strong> · 점심 12:30~14:00</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>토요일</strong></td><td style="padding:10px;border:1px solid #ddd">09:30 ~ <strong>14:00</strong></td><td style="padding:10px;border:1px solid #ddd">점심시간 없이 연속 진료</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>일요일·공휴일</strong></td><td style="padding:10px;border:1px solid #ddd" colspan="2">휴진</td></tr>
</table>
<p>📍 <strong>탑석역 도보 5분</strong> — 대중교통으로도 접근이 편리합니다.<br>🅿️ <strong>주차</strong> — 맞은편 제일식자재마트 건물 지하주차장 이용, 진료 후 무료 주차 쿠폰을 드립니다.</p>`
      },
      {
        heading: '목요일 야간에도 모든 진료 가능',
        content: `<p>일부 치과에서는 야간 시간에 <strong>간단한 진료만</strong> 가능한 경우가 있습니다. 서울가온치과는 목요일 야간에도 아래 <strong>모든 진료</strong>를 동일하게 제공합니다:</p>
<ul>
<li>🦷 <strong>임플란트</strong> — 상담, CT 촬영, 수술 모두 가능</li>
<li>😁 <strong>교정</strong> — 인비절라인·부분교정 상담 및 조정</li>
<li>🪥 <strong>일반 진료</strong> — 충치, 신경치료, 발치, 스케일링</li>
<li>✨ <strong>심미치료</strong> — 라미네이트, 레진빌드업, 미백</li>
<li>🏥 <strong>응급 처치</strong> — 급성 치통, 보철물 탈락, 외상</li>
</ul>`
      }
    ],
    faqs: [
      { q: '의정부에서 야간진료 하는 치과가 있나요?', a: '네, 서울가온치과는 매주 목요일 밤 8시 30분까지 야간진료를 운영합니다. 퇴근 후 7시에 오셔도 충분히 진료 가능합니다.' },
      { q: '목요일 야간에도 임플란트 수술이 가능한가요?', a: '네, 서울가온치과는 목요일 야간에도 임플란트 상담과 수술을 포함한 모든 진료를 동일하게 진행합니다.' },
      { q: '야간 진료에 추가 비용이 있나요?', a: '아니요, 진료 시간에 따른 추가 비용은 없습니다. 낮 시간과 동일한 비용으로 진료 받으실 수 있습니다.' },
    ],
    ctaText: '야간 진료 예약하기',
    relatedLinks: [
      { href: '/emergency-dental', label: '응급치과 안내' },
      { href: '/uijeongbu-dental', label: '의정부 치과 추천' },
      { href: '/tapseok-dental', label: '탑석역 치과' },
      { href: '/reservation', label: '온라인 예약' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 17. 노인 임플란트 / 65세 보험 임플란트 ──
  {
    slug: 'senior-implant',
    title: '의정부 노인 임플란트 | 서울가온치과 — 65세 이상 건강보험 임플란트',
    metaDesc: '의정부 노인 임플란트 서울가온치과. 만 65세 이상 건강보험 임플란트 본인부담금 약 30만원. 고령 환자 전문 안전 시스템. 뼈이식·전체임플란트 가능. 70~80대 시술 경험 풍부. ☎ 0507-1325-3377',
    h1: '노인 임플란트 — 만 65세 이상 건강보험으로 부담 없이',
    heroSub: '나이는 숫자일 뿐. 안전한 시스템으로 어르신도 편안하게 임플란트 받으세요',
    keywords: '노인 임플란트, 65세 임플란트, 건강보험 임플란트, 임플란트 보험, 노인 임플란트 비용, 의정부 노인 임플란트, 고령 임플란트, 어르신 임플란트',
    category: '노인 임플란트',
    sections: [
      {
        heading: '만 65세 이상 임플란트 건강보험 제도',
        content: `<p>대한민국 국민건강보험은 <strong>만 65세 이상</strong>이면 <strong>평생 2개까지</strong> 임플란트에 건강보험을 적용합니다.</p>
<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">항목</th><th style="padding:10px;border:1px solid #ddd">내용</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>대상</strong></td><td style="padding:10px;border:1px solid #ddd">만 65세 이상 건강보험 가입자</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>개수</strong></td><td style="padding:10px;border:1px solid #ddd">평생 2개 (위·아래 각 1개씩 가능)</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>본인부담금</strong></td><td style="padding:10px;border:1px solid #ddd">약 <strong>30%</strong> (약 30만원대)</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>조건</strong></td><td style="padding:10px;border:1px solid #ddd">치아가 빠진 부위 (발치 후 가능)</td></tr>
</table>
<p>💡 무치악(이가 하나도 없는 상태)이 아니더라도 <strong>치아가 상실된 부위</strong>이면 보험이 적용됩니다.</p>`
      },
      {
        heading: '고령 환자를 위한 안전 시스템',
        content: `<p>어르신 환자분들은 <strong>고혈압, 당뇨, 골다공증, 혈액응고제 복용</strong> 등 고려해야 할 사항이 많습니다. 서울가온치과는 고령 환자 안전을 위해 다음 시스템을 운영합니다:</p>
<ul>
<li><strong>전신 건강 사전 평가</strong> — 복용 약물, 기저질환, 혈액검사 등 종합 확인</li>
<li><strong>단계별 치료 계획</strong> — 한꺼번에 무리하지 않고 단계적으로 진행</li>
<li><strong>안전한 마취 관리</strong> — 고혈압·당뇨 환자에 맞춘 마취 프로토콜</li>
<li><strong>편안한 진료 환경</strong> — 1:1 상담실과 회복실을 갖춘 진료 공간</li>
</ul>
<p>서울가온치과는 <strong>70~80대 환자분들의 전체 임플란트 수술</strong>을 다수 경험하였으며, 안전하게 진행합니다.</p>`
      },
      {
        heading: '보험 임플란트 + 비보험 임플란트 병행',
        content: `<p>보험 2개 외에 <strong>추가로 더 많은 임플란트가 필요</strong>한 경우, 비보험으로 추가 식립이 가능합니다. 서울가온치과에서는 보험·비보험을 함께 계획하여 <strong>최적의 저작 기능을 회복</strong>할 수 있도록 안내합니다.</p>
<p>틀니를 사용 중이시라면 <strong>틀니→임플란트 전환</strong>도 상담 가능합니다.</p>`
      }
    ],
    faqs: [
      { q: '만 65세인데 보험 임플란트 받으려면 어떻게 하나요?', a: '서울가온치과에 내원하시면 보험 적용 대상 여부를 바로 확인해 드립니다. 건강보험증과 신분증만 지참하시면 됩니다.' },
      { q: '당뇨가 있는데 임플란트가 가능한가요?', a: '당화혈색소(HbA1c) 수치가 8% 이하로 관리되면 대부분 가능합니다. 내과 주치의와 협진하여 안전하게 진행합니다.' },
      { q: '혈압약·혈액응고제를 먹는데 괜찮나요?', a: '복용 약물에 따라 수술 전 일시적 조정이 필요할 수 있습니다. 사전 상담에서 정확한 약물 리스트를 확인하고 안전한 치료 계획을 세웁니다.' },
      { q: '보험 2개 외에 추가 임플란트도 가능한가요?', a: '네, 보험 2개와 함께 비보험으로 추가 식립이 가능합니다. 전체적인 비용과 치료 계획을 함께 안내드립니다.' },
    ],
    ctaText: '보험 임플란트 상담 예약',
    relatedLinks: [
      { href: '/implant-cost', label: '임플란트 비용 안내' },
      { href: '/denture-to-implant', label: '틀니→임플란트 전환' },
      { href: '/full-mouth-implant', label: '전체 임플란트' },
      { href: '/bone-graft-implant', label: '뼈이식 임플란트' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 18. 의정부 응급치과 ──
  {
    slug: 'emergency-dental',
    title: '의정부 응급치과 | 서울가온치과 — 급한 치통, 즉시 대응',
    metaDesc: '의정부 응급치과 서울가온치과. 갑작스러운 치통, 보철물 탈락, 치아 외상 즉시 대응. 목요일 20:30 야간진료·토요일 14:00까지 진료. 당일 진료 가능. 탑석역 도보 5분. ☎ 0507-1325-3377',
    h1: '의정부 응급치과 — 급한 치통, 빠르게 해결',
    heroSub: '갑자기 이가 아프세요? 참지 마시고 지금 바로 연락하세요',
    keywords: '의정부 응급치과, 의정부 치통, 응급 치과, 급한 치통, 치아 외상, 보철물 탈락, 의정부 당일 치과, 의정부 아픈 이',
    category: '응급치과',
    sections: [
      {
        heading: '이런 증상이면 즉시 방문하세요',
        content: `<ul>
<li>🔴 <strong>극심한 치통</strong> — 진통제를 먹어도 안 가라앉는 통증</li>
<li>🔴 <strong>잇몸 붓기·고름</strong> — 잇몸이 부어오르고 열감이 있을 때</li>
<li>🔴 <strong>치아 깨짐·빠짐</strong> — 넘어지거나 부딪혀 치아가 손상되었을 때</li>
<li>🔴 <strong>보철물 탈락</strong> — 크라운, 브릿지, 임플란트 보철이 빠졌을 때</li>
<li>🔴 <strong>출혈이 멈추지 않을 때</strong> — 발치 후 또는 외상 후 지혈이 안 될 때</li>
</ul>
<p>💡 <strong>서울가온치과는 당일 진료가 가능합니다.</strong> 전화로 증상을 말씀해 주시면, 가장 빠른 시간에 진료를 안내드립니다.</p>`
      },
      {
        heading: '응급 상황 대처법',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">상황</th><th style="padding:10px;border:1px solid #ddd">응급 처치</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>극심한 치통</strong></td><td style="padding:10px;border:1px solid #ddd">진통제(이부프로펜) 복용 후 최대한 빨리 내원</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>치아가 빠졌을 때</strong></td><td style="padding:10px;border:1px solid #ddd">빠진 치아를 우유에 담가 30분 이내 내원 (재식립 가능)</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>보철물 탈락</strong></td><td style="padding:10px;border:1px solid #ddd">탈락된 보철물 보관 후 내원 (재부착 가능)</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>잇몸 출혈</strong></td><td style="padding:10px;border:1px solid #ddd">깨끗한 거즈로 10분간 눌러 지혈, 이후 내원</td></tr>
</table>`
      },
      {
        heading: '서울가온치과 응급 진료 시스템',
        content: `<p>서울가온치과는 <strong>응급 환자를 위한 당일 슬롯</strong>을 확보하고 있습니다:</p>
<ul>
<li>📞 <strong>전화 우선 안내</strong> — 전화 시 증상 확인 후 가장 빠른 시간대 배정</li>
<li>🏥 <strong>즉시 진단</strong> — 디지털 X-ray·CT로 원인 즉시 파악</li>
<li>💉 <strong>통증 완화 우선</strong> — 진단과 동시에 통증 완화 처치 진행</li>
<li>📋 <strong>근본 치료 계획</strong> — 응급 처치 후 원인에 따른 근본 치료 안내</li>
</ul>
<p>⏰ 진료시간: <strong>평일 09:30~18:30 / 목요일 야간 ~20:30 / 토요일 09:30~14:00</strong></p>`
      }
    ],
    faqs: [
      { q: '갑자기 이가 너무 아픈데 오늘 바로 진료 받을 수 있나요?', a: '네, 서울가온치과는 당일 진료가 가능합니다. 전화(0507-1325-3377)로 증상을 말씀해 주시면 가장 빠른 시간에 안내드립니다.' },
      { q: '밤에 치통이 생기면 어떻게 하나요?', a: '진통제(이부프로펜 등)를 복용하고, 차가운 물로 입을 헹궈주세요. 다음날 아침 바로 내원해 주시면 빠르게 처치해 드립니다.' },
      { q: '넘어져서 앞니가 빠졌어요. 다시 붙일 수 있나요?', a: '빠진 치아를 우유나 식염수에 담가 30분 이내에 방문하시면 재식립(다시 심기)이 가능할 수 있습니다. 치아를 만지지 말고 뿌리 부분이 아닌 머리 부분을 잡아주세요.' },
    ],
    ctaText: '응급 진료 전화하기',
    relatedLinks: [
      { href: '/night-dental', label: '야간진료 안내' },
      { href: '/cavity-treatment', label: '충치치료 안내' },
      { href: '/uijeongbu-dental', label: '의정부 치과 추천' },
      { href: '/reservation', label: '온라인 예약' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 19. 탑석역 치과 ── (2026-10-08 사실 정정: 레포 검증 정보만 — 탑석역 1번 출구 도보 5분·실제 진료시간·제일식자재마트 주차)
  {
    slug: 'tapseok-dental',
    title: '탑석역 치과 | 서울가온치과 — 탑석역 1번 출구 도보 5분',
    metaDesc: '탑석역 치과 서울가온치과. 탑석역 1번 출구에서 걸어서 약 5분, 의정부시 용민로 22 골드자이프라자 4층. 임플란트·신경치료·앞니 심미·교정·일반진료, 목요일 20:30 야간진료. 현진호 대표원장. ☎ 0507-1325-3377',
    h1: '탑석역 치과 — 1번 출구에서 걸어서 5분',
    heroSub: '탑석센트럴자이 정문 앞 골드자이프라자 4층, 탑석역 1번 출구에서 도보 약 5분',
    keywords: '탑석역 치과, 탑석 치과, 탑석역 임플란트, 탑석역 교정, 탑석 근처 치과, 의정부 탑석 치과, 탑석역 치과 추천',
    category: '탑석역 치과',
    sections: [
      {
        heading: '탑석역에서 서울가온치과 오시는 길',
        content: `<p>서울가온치과는 <strong>탑석역 1번 출구에서 걸어서 약 5분</strong> 거리입니다. 탑석센트럴자이 정문 맞은편, 배스킨라빈스가 입점한 골드자이프라자 건물 4층으로 올라오시면 됩니다.</p>
<ul>
<li>🚇 <strong>지하철</strong> — 탑석역 1번 출구로 나와 도보 약 5분</li>
<li>🚌 <strong>버스</strong> — 탑석센트럴자이 정류장 하차 (201, 201-1, 72번 등)</li>
<li>🚗 <strong>차량</strong> — 길 건너 제일식자재마트 건물 지하주차장에 주차하시고, 진료 후 데스크에서 무료 주차 쿠폰을 받으세요</li>
</ul>
<p>📍 주소: <strong>경기도 의정부시 용민로 22, 골드자이프라자 4층(용현동)</strong></p>`
      },
      {
        heading: '탑석 주민들이 서울가온치과를 찾는 이유',
        content: `<ul>
<li><strong>진료 분야별 담당 원장</strong> — 임플란트·보철은 현진호 대표원장(통합치의학과 전문의), 신경치료·자연치아 보존은 조은비 원장(치과보존과 전문의)이 맡습니다</li>
<li><strong>CT 기반 가이드 임플란트</strong> — 촬영 영상으로 식립 위치를 미리 계획한 뒤 수술합니다</li>
<li><strong>목요일 야간진료</strong> — 매주 목요일은 20:30까지 진료해 퇴근 후에도 내원하실 수 있습니다</li>
<li><strong>설명 먼저, 치료는 그 다음</strong> — 1:1 상담실에서 촬영 사진을 함께 보며 치료 계획과 비용을 서면으로 안내합니다</li>
</ul>`
      },
      {
        heading: '서울가온치과 주요 진료과목',
        content: `<ul>
<li>🦷 <strong>임플란트</strong> — 단일·전체·뼈이식·상악동거상술 / 만 65세 이상 건강보험 적용</li>
<li>😁 <strong>교정</strong> — 인비절라인·부분교정·심미교정</li>
<li>✨ <strong>심미치료</strong> — 라미네이트·레진빌드업·미백</li>
<li>🪥 <strong>일반 진료</strong> — 충치·신경치료·발치·스케일링</li>
<li>🦴 <strong>사랑니</strong> — 매복사랑니 발치</li>
<li>💪 <strong>잇몸치료</strong> — 스케일링·치주치료</li>
</ul>
<p>진료시간은 월·화·수·금 09:30~18:30, 목요일 09:30~20:30, 토요일 09:30~14:00이며 평일 점심시간은 12:30~14:00, 일요일·공휴일은 휴진입니다.</p>`
      }
    ],
    faqs: [
      { q: '탑석역에서 서울가온치과까지 얼마나 걸리나요?', a: '탑석역 1번 출구에서 걸어서 약 5분입니다. 탑석센트럴자이 정문 맞은편 골드자이프라자 건물 4층으로 오시면 됩니다.' },
      { q: '탑석역 근처에서 임플란트 상담을 받고 싶어요', a: '서울가온치과는 현진호 대표원장이 CT 영상으로 식립 위치를 미리 계획하는 가이드 임플란트를 직접 진료합니다. 상담 때 촬영 사진을 함께 보며 치료 계획과 비용을 서면으로 안내해 드립니다.' },
      { q: '주차가 가능한가요?', a: '네. 병원 맞은편 제일식자재마트 건물 지하주차장을 이용하시면 되고, 진료 후 데스크에서 무료 주차 쿠폰을 드립니다.' },
    ],
    ctaText: '탑석역 → 서울가온치과 상담 예약',
    relatedLinks: [
      { href: '/uijeongbu-dental', label: '의정부 치과 추천' },
      { href: '/implant', label: '임플란트 안내' },
      { href: '/night-dental', label: '야간진료 안내' },
      { href: '/treatments', label: '진료과목 안내' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 20. 의정부 무통치료 / 수면치과 ──
  {
    slug: 'painless-dental',
    title: '의정부 무통치료 치과 | 서울가온치과 — 아프지 않은 치과 치료',
    metaDesc: '의정부 무통치료 서울가온치과. 치과 공포증 전문 관리. 무통마취 시스템, 진정(수면) 치료, 세심한 통증 관리로 편안한 치과 경험. 아이부터 어르신까지. ☎ 0507-1325-3377',
    h1: '의정부 무통치료 — 아프지 않은 치과, 서울가온치과',
    heroSub: '치과가 무서우셨나요? 서울가온치과는 다릅니다. 아프지 않게, 편안하게',
    keywords: '의정부 무통치료, 의정부 수면치과, 무통 치과, 치과 공포증, 아프지 않은 치과, 무통 마취, 진정 치료, 의정부 편안한 치과',
    category: '무통치료',
    sections: [
      {
        heading: '왜 치과가 무서울까요?',
        content: `<p><strong>치과 공포증</strong>은 매우 흔합니다. 성인 약 40%가 치과 방문에 불안을 느끼며, 이로 인해 치료를 미루다 병을 키우는 경우가 많습니다.</p>
<p>서울가온치과는 <strong>"모든 치료는 통증 관리부터"</strong>라는 원칙으로, 환자의 불안과 통증을 최소화하는 시스템을 운영합니다.</p>`
      },
      {
        heading: '서울가온치과 무통 시스템',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">단계</th><th style="padding:10px;border:1px solid #ddd">방법</th><th style="padding:10px;border:1px solid #ddd">효과</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>1단계</strong></td><td style="padding:10px;border:1px solid #ddd">표면마취제 도포</td><td style="padding:10px;border:1px solid #ddd">주사 바늘이 들어갈 때 통증 제거</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>2단계</strong></td><td style="padding:10px;border:1px solid #ddd">컴퓨터 제어 마취 (전동주사기)</td><td style="padding:10px;border:1px solid #ddd">일정한 속도·압력으로 통증 최소화</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>3단계</strong></td><td style="padding:10px;border:1px solid #ddd">충분한 마취 대기</td><td style="padding:10px;border:1px solid #ddd">마취가 완전히 될 때까지 기다린 후 시술</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>선택</strong></td><td style="padding:10px;border:1px solid #ddd">진정(수면) 치료</td><td style="padding:10px;border:1px solid #ddd">극도의 불안감 해소, 편안한 상태에서 치료</td></tr>
</table>`
      },
      {
        heading: '이런 분들께 추천합니다',
        content: `<ul>
<li>😰 <strong>치과 공포증</strong>이 있어 치료를 계속 미루신 분</li>
<li>👶 <strong>아이</strong>가 치과를 무서워해서 치료가 어려운 경우</li>
<li>🦷 <strong>임플란트 수술</strong>이 무서워서 망설이시는 분</li>
<li>👴 <strong>어르신</strong>으로 전신 질환이 있어 안전한 마취가 필요한 분</li>
<li>🤢 <strong>구역질 반사</strong>가 심해서 치과 기구가 입에 들어가면 힘든 분</li>
</ul>
<p>서울가온치과에서는 환자 한 분 한 분의 <strong>불안 정도를 사전에 파악</strong>하고, 맞춤형 통증 관리 플랜을 제공합니다.</p>`
      }
    ],
    faqs: [
      { q: '정말 안 아프게 치료할 수 있나요?', a: '100% 통증 제로를 보장할 수는 없지만, 표면마취 + 전동주사기 + 충분한 마취 대기의 3단계 시스템으로 대부분의 환자분들이 "생각보다 안 아팠다"고 말씀하십니다.' },
      { q: '수면치료(진정치료)는 어떻게 하나요?', a: '정맥진정법을 통해 반수면 상태에서 치료를 진행합니다. 잠든 것처럼 편안한 상태이며, 치료가 끝나면 자연스럽게 깨어나십니다.' },
      { q: '아이도 무통치료가 가능한가요?', a: '네, 소아 환자에게도 표면마취와 전동주사기를 사용하며, 아이의 심리적 안정을 위한 단계적 적응 프로그램도 운영합니다.' },
      { q: '무통치료에 추가 비용이 있나요?', a: '일반적인 무통마취(표면마취, 전동주사기)는 별도 추가 비용 없이 제공됩니다. 진정(수면) 치료는 별도 비용이 발생하며, 상담 시 안내드립니다.' },
    ],
    ctaText: '무통 치료 상담 예약',
    relatedLinks: [
      { href: '/implant', label: '임플란트 안내' },
      { href: '/cavity-treatment', label: '충치치료 안내' },
      { href: '/uijeongbu-dental', label: '의정부 치과 추천' },
      { href: '/emergency-dental', label: '응급치과 안내' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 21. 의정부 소아치과 ──
  {
    slug: 'pediatric-dental',
    title: '의정부 소아치과 | 서울가온치과 — 아이가 무서워하지 않는 치과',
    metaDesc: '의정부 소아치과 서울가온치과. 아이 눈높이 진료, 단계적 적응 프로그램, 무통마취 시스템. 유치 충치, 실란트, 불소도포, 소아 교정 상담. 보호자 동반 진료 가능. ☎ 0507-1325-3377',
    h1: '의정부 소아치과 — 아이가 웃으며 다니는 치과',
    heroSub: '무서움 없이, 울음 없이. 아이 눈높이에서 시작하는 치과 진료',
    keywords: '의정부 소아치과, 의정부 어린이 치과, 소아 충치, 유치 치료, 실란트, 불소도포, 의정부 아이 치과, 소아 치과 추천',
    category: '소아치과',
    sections: [
      {
        heading: '아이가 치과를 무서워하는 이유',
        content: `<p>아이들은 낯선 환경, 치과 기구 소리, 통증에 대한 두려움으로 치과를 무서워합니다. <strong>첫 치과 경험이 부정적이면</strong> 평생 치과 공포증으로 이어질 수 있습니다.</p>
<p>서울가온치과는 <strong>아이의 심리적 안정을 최우선</strong>으로 하는 소아 진료 시스템을 운영합니다. 첫 방문에서 바로 치료하지 않고, <strong>단계적으로 치과에 적응</strong>시킨 뒤 치료를 시작합니다.</p>`
      },
      {
        heading: '소아 진료 프로그램',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">진료</th><th style="padding:10px;border:1px solid #ddd">대상</th><th style="padding:10px;border:1px solid #ddd">설명</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>실란트</strong></td><td style="padding:10px;border:1px solid #ddd">만 6~14세</td><td style="padding:10px;border:1px solid #ddd">어금니 홈 메우기 — <strong>건강보험 적용</strong></td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>불소도포</strong></td><td style="padding:10px;border:1px solid #ddd">만 5세~</td><td style="padding:10px;border:1px solid #ddd">치아 표면 강화, 충치 예방</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>유치 충치치료</strong></td><td style="padding:10px;border:1px solid #ddd">유치 시기</td><td style="padding:10px;border:1px solid #ddd">레진·글래스아이오노머 충전</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>유치 신경치료</strong></td><td style="padding:10px;border:1px solid #ddd">심한 유치 충치</td><td style="padding:10px;border:1px solid #ddd">영구치 보호를 위한 유치 보존</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>소아 교정 상담</strong></td><td style="padding:10px;border:1px solid #ddd">만 7세~</td><td style="padding:10px;border:1px solid #ddd">부정교합 조기 발견 및 치료 시기 안내</td></tr>
</table>`
      },
      {
        heading: '서울가온치과 소아 진료 특장점',
        content: `<ul>
<li>🧸 <strong>단계적 적응</strong> — Tell-Show-Do 방식으로 기구를 보여주고 설명 후 치료</li>
<li>💉 <strong>무통마취</strong> — 표면마취 + 전동주사기로 아이도 아프지 않게</li>
<li>👨‍👩‍👧 <strong>보호자 동반</strong> — 부모님이 함께 진료실에 들어오실 수 있습니다</li>
<li>🎯 <strong>유치 보존 원칙</strong> — 유치가 빠지는 시기까지 최대한 보존하여 영구치 공간 확보</li>
<li>📋 <strong>양치 교육</strong> — 올바른 칫솔질과 구강 관리법 교육</li>
</ul>`
      }
    ],
    faqs: [
      { q: '아이가 너무 무서워하는데 치료가 가능한가요?', a: '네, 처음부터 치료하지 않고 단계적으로 적응시킵니다. 체어에 앉기, 기구 만져보기, 거울로 입안 보기 등 순서대로 진행하며, 아이가 편안해진 뒤 치료를 시작합니다.' },
      { q: '유치는 어차피 빠지는데 치료해야 하나요?', a: '네, 유치 충치를 방치하면 영구치에 감염이 전파되거나, 조기 탈락으로 영구치 공간이 부족해져 부정교합이 생길 수 있습니다.' },
      { q: '실란트는 보험이 되나요?', a: '네, 만 6~14세는 제1·제2 대구치(큰 어금니) 실란트에 건강보험이 적용됩니다.' },
      { q: '소아 교정은 몇 살에 시작하나요?', a: '일반적으로 만 7세 전후 첫 교정 검진을 권장합니다. 턱뼈 성장과 영구치 맹출 상태에 따라 적절한 치료 시기를 안내드립니다.' },
    ],
    ctaText: '소아 치과 상담 예약',
    relatedLinks: [
      { href: '/painless-dental', label: '무통치료 안내' },
      { href: '/cavity-treatment', label: '충치치료 안내' },
      { href: '/orthodontics', label: '교정 안내' },
      { href: '/dental-checkup', label: '정기검진 안내' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 22. 의정부 크라운 / 지르코니아 ──
  {
    slug: 'crown',
    title: '의정부 크라운 치료 | 서울가온치과 — 지르코니아·올세라믹 크라운',
    metaDesc: '의정부 크라운 서울가온치과. 지르코니아 크라운, 올세라믹 크라운, PFM 크라운 맞춤 제작. 자연치아 색상 맞춤, 1:1 기공소 협업. 신경치료 후 크라운, 임플란트 보철 진료. ☎ 0507-1325-3377',
    h1: '의정부 크라운 치료 — 자연치아처럼 아름답고 튼튼하게',
    heroSub: '정밀한 보철, 오래가는 크라운. 서울가온치과의 크라운 치료를 만나보세요',
    keywords: '의정부 크라운, 지르코니아 크라운, 올세라믹 크라운, 의정부 보철, 크라운 비용, 크라운 치료, PFM 크라운, 의정부 지르코니아',
    category: '크라운',
    sections: [
      {
        heading: '크라운이 필요한 경우',
        content: `<ul>
<li>🦷 <strong>신경치료 후</strong> — 신경치료를 받은 치아는 약해져서 크라운으로 보호해야 합니다</li>
<li>🔨 <strong>치아가 많이 손상</strong> — 충치가 넓거나 치아가 깨져 레진으로 불가능한 경우</li>
<li>🦴 <strong>임플란트 보철</strong> — 임플란트 식립 후 최종 보철(크라운) 제작</li>
<li>✨ <strong>심미 목적</strong> — 변색·형태 개선을 위한 올세라믹 크라운</li>
</ul>`
      },
      {
        heading: '크라운 종류 비교',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">종류</th><th style="padding:10px;border:1px solid #ddd">소재</th><th style="padding:10px;border:1px solid #ddd">장점</th><th style="padding:10px;border:1px solid #ddd">추천 부위</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>지르코니아</strong></td><td style="padding:10px;border:1px solid #ddd">산화지르코늄</td><td style="padding:10px;border:1px solid #ddd">최고 강도 + 자연 색상</td><td style="padding:10px;border:1px solid #ddd">어금니·앞니 모두</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>올세라믹</strong></td><td style="padding:10px;border:1px solid #ddd">도자기 세라믹</td><td style="padding:10px;border:1px solid #ddd">최고 심미성, 자연 투명도</td><td style="padding:10px;border:1px solid #ddd">앞니(심미 부위)</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>PFM</strong></td><td style="padding:10px;border:1px solid #ddd">금속+세라믹</td><td style="padding:10px;border:1px solid #ddd">내구성 우수, 합리적 가격</td><td style="padding:10px;border:1px solid #ddd">어금니</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>골드</strong></td><td style="padding:10px;border:1px solid #ddd">금합금</td><td style="padding:10px;border:1px solid #ddd">생체적합성 최고, 초장수명</td><td style="padding:10px;border:1px solid #ddd">어금니(비심미 부위)</td></tr>
</table>`
      },
      {
        heading: '서울가온치과 크라운 치료의 차이',
        content: `<p>크라운의 완성도는 <strong>치과의사의 삭제 정밀도</strong>와 <strong>기공사의 제작 실력</strong>에 달려 있습니다.</p>
<ul>
<li>🔬 <strong>디지털 인상</strong> — 구강 스캐너로 정밀 채득 (기존 실리콘 인상보다 정확)</li>
<li>🎨 <strong>1:1 기공소 협업</strong> — 전문 기공소와의 긴밀한 소통으로 자연 색상 재현</li>
<li>⚕️ <strong>최소 삭제</strong> — 필요한 만큼만 삭제하여 자연치아 최대 보존</li>
<li>✅ <strong>적합도 검증</strong> — 장착 전 맞물림·색상·형태 꼼꼼히 확인</li>
</ul>`
      }
    ],
    faqs: [
      { q: '지르코니아와 올세라믹 중 어떤 게 좋나요?', a: '어금니(저작력 필요)는 강도가 높은 지르코니아, 앞니(심미성 중요)는 투명도가 뛰어난 올세라믹을 추천합니다. 최근에는 심미 지르코니아가 앞니에도 많이 사용됩니다.' },
      { q: '크라운은 얼마나 오래 가나요?', a: '소재와 관리에 따라 다르지만, 지르코니아·올세라믹은 10~15년 이상, 골드 크라운은 20년 이상 사용 가능합니다.' },
      { q: '크라운 치료는 몇 번 방문해야 하나요?', a: '일반적으로 2~3회 방문합니다. 치아 삭제·인상(1회) → 기공소 제작(1~2주) → 최종 장착(1회).' },
      { q: '크라운이 빠졌는데 다시 붙일 수 있나요?', a: '크라운과 치아 상태가 양호하면 재접착이 가능합니다. 빠진 크라운을 보관하시고 가능한 빨리 방문해 주세요.' },
    ],
    ctaText: '크라운 상담 예약',
    relatedLinks: [
      { href: '/endodontics', label: '신경치료 안내' },
      { href: '/aesthetic', label: '심미치료 안내' },
      { href: '/laminate', label: '라미네이트 안내' },
      { href: '/implant', label: '임플란트 안내' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 23. 의정부 치아미백 ──
  {
    slug: 'teeth-whitening',
    title: '의정부 치아미백 | 서울가온치과 — 치아미백으로 환하게',
    metaDesc: '의정부 치아미백 서울가온치과. 오피스 미백 + 자가 미백 병행 프로그램. 변색·착색 개선. 라미네이트 전 색상 맞춤 미백. 안전한 약제, 시린 증상 최소화. ☎ 0507-1325-3377',
    h1: '의정부 치아미백 — 자신 있는 밝은 미소',
    heroSub: '누런 치아, 착색된 치아를 밝고 환하게. 맞춤 미백 프로그램을 경험하세요',
    keywords: '의정부 치아미백, 의정부 미백, 치아 미백 비용, 오피스 미백, 자가 미백, 치아 착색, 치아 변색, 의정부 미백 치과',
    category: '치아미백',
    sections: [
      {
        heading: '치아가 변색되는 원인',
        content: `<p>치아 변색은 <strong>외인성</strong>(커피·와인·흡연·카레 등 음식물 착색)과 <strong>내인성</strong>(테트라사이클린 항생제, 외상, 노화)으로 나뉩니다.</p>
<p>외인성 변색은 스케일링과 미백으로 개선이 잘 되며, 내인성 변색은 미백 + 라미네이트 등 복합 치료가 필요할 수 있습니다.</p>`
      },
      {
        heading: '미백 프로그램 안내',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">종류</th><th style="padding:10px;border:1px solid #ddd">방법</th><th style="padding:10px;border:1px solid #ddd">효과</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>오피스 미백</strong><br>(치과 미백)</td><td style="padding:10px;border:1px solid #ddd">병원에서 고농도 미백제 + LED 조사<br>1회 약 40~60분</td><td style="padding:10px;border:1px solid #ddd">즉시 2~4단계 밝아짐<br>빠른 효과</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>자가 미백</strong><br>(홈 블리칭)</td><td style="padding:10px;border:1px solid #ddd">맞춤 트레이 + 저농도 미백제<br>매일 30분~2시간, 2~4주</td><td style="padding:10px;border:1px solid #ddd">점진적 미백<br>유지 효과 우수</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>듀얼 미백</strong><br>(병행)</td><td style="padding:10px;border:1px solid #ddd">오피스 + 자가 병행</td><td style="padding:10px;border:1px solid #ddd"><strong>최고 효과</strong><br>가장 많이 추천</td></tr>
</table>`
      },
      {
        heading: '미백 시 시린 증상 관리',
        content: `<p>미백 후 일시적으로 <strong>시린 증상</strong>이 나타날 수 있습니다. 서울가온치과에서는:</p>
<ul>
<li>🛡️ <strong>잇몸 보호</strong> — 미백 전 잇몸에 보호 레진 도포</li>
<li>💊 <strong>탈감작제</strong> — 미백 전후 시린 이 완화제 적용</li>
<li>⚗️ <strong>안전한 약제</strong> — FDA 승인 미백 약제만 사용</li>
<li>📋 <strong>개인 맞춤</strong> — 치아 상태에 따라 농도·시간 조절</li>
</ul>`
      }
    ],
    faqs: [
      { q: '치아 미백은 안전한가요?', a: '네, FDA 승인 약제를 사용하며 전문가 감독 하에 진행하므로 안전합니다. 일시적 시린 증상이 있을 수 있으나 보통 1~2일 내 사라집니다.' },
      { q: '미백 효과는 얼마나 지속되나요?', a: '개인 식습관에 따라 다르지만 보통 1~2년 유지됩니다. 커피·와인·흡연을 줄이면 더 오래 유지되고, 자가 미백 트레이로 터치업이 가능합니다.' },
      { q: '레진이나 크라운도 미백되나요?', a: '아닙니다. 미백은 자연치아에만 효과가 있습니다. 보철물이 있으면 미백 후 보철물 색상 교체를 고려할 수 있습니다.' },
    ],
    ctaText: '미백 상담 예약',
    relatedLinks: [
      { href: '/aesthetic', label: '심미치료 안내' },
      { href: '/laminate', label: '라미네이트 안내' },
      { href: '/scaling-gum-treatment', label: '스케일링 안내' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 24. 의정부 치과 검진 ──
  {
    slug: 'dental-checkup',
    title: '의정부 치과 정기검진 | 서울가온치과 — 예방이 최선의 치료',
    metaDesc: '의정부 치과 정기검진 서울가온치과. 6개월마다 구강검진 + 스케일링으로 충치·잇몸질환 조기 발견. 파노라마·CT 정밀 검사. 건강보험 스케일링 연 1회. ☎ 0507-1325-3377',
    h1: '의정부 치과 정기검진 — 예방이 최선의 치료입니다',
    heroSub: '아프기 전에 찾아오세요. 6개월마다 정기검진이 최고의 치과 보험입니다',
    keywords: '의정부 치과 검진, 치과 정기검진, 구강검진, 의정부 스케일링, 치과 건강검진, 충치 예방, 잇몸 검진',
    category: '정기검진',
    sections: [
      {
        heading: '왜 정기검진이 중요한가요?',
        content: `<p>충치와 잇몸질환은 <strong>초기에 증상이 거의 없습니다</strong>. 통증을 느낄 때는 이미 상당히 진행된 상태이며, 그때는 신경치료나 발치가 필요한 경우가 많습니다.</p>
<p><strong>6개월마다 정기검진</strong>을 받으면:</p>
<ul>
<li>초기 충치를 간단한 레진 치료로 끝낼 수 있습니다</li>
<li>잇몸 질환을 스케일링만으로 관리할 수 있습니다</li>
<li>치료 비용과 시간을 대폭 절약할 수 있습니다</li>
<li>자연치아를 더 오래 지킬 수 있습니다</li>
</ul>`
      },
      {
        heading: '서울가온치과 검진 프로그램',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">검사 항목</th><th style="padding:10px;border:1px solid #ddd">내용</th><th style="padding:10px;border:1px solid #ddd">보험</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>구강 검진</strong></td><td style="padding:10px;border:1px solid #ddd">육안 + 탐침 검사, 충치·잇몸 상태 확인</td><td style="padding:10px;border:1px solid #ddd">보험 적용</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>파노라마 X-ray</strong></td><td style="padding:10px;border:1px solid #ddd">전체 치아·턱뼈 촬영, 숨은 충치 발견</td><td style="padding:10px;border:1px solid #ddd">보험 적용</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>스케일링</strong></td><td style="padding:10px;border:1px solid #ddd">치석 제거, 잇몸 건강 유지</td><td style="padding:10px;border:1px solid #ddd"><strong>연 1회 보험</strong> (만 19세+)</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>CT 촬영</strong></td><td style="padding:10px;border:1px solid #ddd">3차원 정밀 검사 (필요 시)</td><td style="padding:10px;border:1px solid #ddd">일부 보험</td></tr>
</table>
<p>💡 <strong>국민건강보험</strong>에서는 만 19세 이상 연 1회 스케일링 보험을 지원합니다.</p>`
      },
      {
        heading: '이런 분께 특히 권합니다',
        content: `<ul>
<li>☕ <strong>커피·흡연</strong>을 자주 하시는 분 — 착색·치석 관리</li>
<li>🦷 <strong>충치 경험</strong>이 많으신 분 — 재발 방지</li>
<li>👴 <strong>어르신</strong> — 잇몸질환·치아 마모 체크</li>
<li>👶 <strong>아이</strong> — 유치→영구치 교환기 관리</li>
<li>🦴 <strong>임플란트</strong> 하신 분 — 임플란트 주위염 예방</li>
</ul>`
      }
    ],
    faqs: [
      { q: '정기검진은 얼마나 자주 받아야 하나요?', a: '일반적으로 6개월에 1회를 권장합니다. 잇몸질환이 있거나 임플란트를 하신 분은 3~4개월에 1회가 이상적입니다.' },
      { q: '스케일링 보험은 어떻게 받나요?', a: '만 19세 이상이면 연 1회 건강보험 적용 스케일링을 받으실 수 있습니다. 건강보험증만 지참하시면 됩니다.' },
      { q: '검진 비용은 얼마인가요?', a: '구강검진과 파노라마는 건강보험이 적용되어 본인부담금이 적습니다. 스케일링도 연 1회 보험 적용됩니다.' },
    ],
    ctaText: '정기검진 예약',
    relatedLinks: [
      { href: '/scaling-gum-treatment', label: '스케일링·잇몸치료' },
      { href: '/cavity-treatment', label: '충치치료 안내' },
      { href: '/pediatric-dental', label: '소아치과 안내' },
      { href: '/uijeongbu-dental', label: '의정부 치과 추천' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 25. 임플란트 과정 / 시술기간 ──
  {
    slug: 'implant-process',
    title: '의정부 임플란트 과정 및 기간 | 서울가온치과 — 단계별 상세 안내',
    metaDesc: '임플란트 과정이 궁금하세요? 서울가온치과 임플란트 시술 단계별 안내. CT 촬영→수술→치유→보철 완성까지 전 과정. 기간 2~6개월. 당일 임시치아 가능. 현진호 대표원장 직접 수술. ☎ 0507-1325-3377',
    h1: '임플란트 과정 — 수술부터 보철 완성까지 단계별 안내',
    heroSub: '처음이라 막막하신가요? 임플란트 전 과정을 알기 쉽게 설명해 드립니다',
    keywords: '임플란트 과정, 임플란트 시술기간, 임플란트 수술 과정, 임플란트 단계, 임플란트 기간, 임플란트 얼마나 걸리나, 의정부 임플란트 과정',
    category: '임플란트 과정',
    sections: [
      {
        heading: '임플란트 시술 5단계',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:10px;border:1px solid #ddd">단계</th><th style="padding:10px;border:1px solid #ddd">내용</th><th style="padding:10px;border:1px solid #ddd">소요 시간</th></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>1단계</strong><br>상담·검사</td><td style="padding:10px;border:1px solid #ddd">CT 촬영, 구강 검진, 치료 계획 수립<br>비용·기간 안내</td><td style="padding:10px;border:1px solid #ddd">약 30~40분</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>2단계</strong><br>임플란트 식립</td><td style="padding:10px;border:1px solid #ddd">CT 가이드 기반 정확한 위치에 픽스쳐(나사) 식립<br>무절개 또는 최소절개</td><td style="padding:10px;border:1px solid #ddd">1개 약 20~30분</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>3단계</strong><br>치유 기간</td><td style="padding:10px;border:1px solid #ddd">뼈와 임플란트가 결합(골유착)되는 기간<br>임시치아 착용 가능</td><td style="padding:10px;border:1px solid #ddd"><strong>위턱 3~4개월</strong><br><strong>아래턱 2~3개월</strong></td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>4단계</strong><br>지대주·인상</td><td style="padding:10px;border:1px solid #ddd">연결 장치(지대주) 장착<br>디지털 인상 채득</td><td style="padding:10px;border:1px solid #ddd">약 20분</td></tr>
<tr><td style="padding:10px;border:1px solid #ddd"><strong>5단계</strong><br>보철 완성</td><td style="padding:10px;border:1px solid #ddd">최종 크라운(보철물) 장착<br>맞물림·색상 확인</td><td style="padding:10px;border:1px solid #ddd">약 20분</td></tr>
</table>`
      },
      {
        heading: '총 기간은 얼마나 걸리나요?',
        content: `<ul>
<li><strong>일반적인 경우</strong>: <strong>2~4개월</strong> (발치 후 치유 완료 기준)</li>
<li><strong>발치 즉시 식립</strong>: <strong>2~3개월</strong> (발치와 동시에 임플란트 식립)</li>
<li><strong>뼈이식 동반</strong>: <strong>4~6개월</strong> (뼈이식 + 골유착 기간)</li>
<li><strong>상악동거상술</strong>: <strong>6~9개월</strong> (위턱 뼈가 부족한 경우)</li>
</ul>
<p>💡 <strong>치유 기간 중에도 임시치아</strong>를 착용할 수 있어 일상생활에 불편이 없습니다.</p>`
      },
      {
        heading: '서울가온치과의 임플란트 수술 방식',
        content: `<ul>
<li>🖥️ <strong>CT 가이드 수술</strong> — 3D CT 데이터로 사전 시뮬레이션, 0.1mm 정밀도</li>
<li>🔬 <strong>무절개/최소절개</strong> — 잇몸 절개 최소화, 출혈·부기 감소</li>
<li>💉 <strong>무통 마취</strong> — 3단계 마취 시스템으로 수술 중 통증 없음</li>
<li>👨‍⚕️ <strong>현진호 대표원장 직접</strong> — 모든 임플란트 수술을 직접 진행</li>
</ul>`
      }
    ],
    faqs: [
      { q: '임플란트 수술은 아프나요?', a: '수술 중에는 마취가 되어 있어 통증이 없습니다. 수술 후 1~2일 정도 약간의 붓기와 불편감이 있을 수 있으나, 처방된 진통제로 관리됩니다.' },
      { q: '임플란트 수술 당일 바로 일상생활이 가능한가요?', a: '대부분의 경우 당일 귀가 후 가벼운 일상생활이 가능합니다. 격렬한 운동은 2~3일 피해주시는 것이 좋습니다.' },
      { q: '발치하고 바로 임플란트를 심을 수 있나요?', a: '뼈 상태가 양호하면 발치 즉시 임플란트 식립(즉시 식립)이 가능합니다. CT 촬영 후 결정합니다.' },
      { q: '임플란트는 얼마나 오래 가나요?', a: '잘 관리하면 20년 이상 사용 가능합니다. 정기적인 검진과 꼼꼼한 구강 관리가 중요합니다.' },
    ],
    ctaText: '임플란트 상담 예약',
    relatedLinks: [
      { href: '/implant', label: '임플란트 상세 안내' },
      { href: '/implant-cost', label: '임플란트 비용 안내' },
      { href: '/implant-best', label: '임플란트 잘하는 곳' },
      { href: '/bone-graft-implant', label: '뼈이식 임플란트' },
      { href: '/before-after', label: '전후 사례 보기' },
    ]
  },
  // ── 26. 민락동 치과 ── (2026-10-08 사실 정정: 레포 검증 정보만)
  {
    slug: 'minrak-dental',
    title: '민락동 치과 | 서울가온치과 — 민락 주민이 찾는 종합 치과',
    metaDesc: '민락동 치과 서울가온치과. 민락동·민락2지구에서 차로 약 5~10분, 의정부시 용민로 22 골드자이프라자 4층(탑석역 1번 출구 도보 약 5분). 임플란트·신경치료·심미·교정·소아 진료. ☎ 0507-1325-3377',
    h1: '민락동 치과 — 민락에서 가까운 용현동 서울가온치과',
    heroSub: '민락동·민락2지구에서 차로 5~10분. 두 원장이 진료 분야를 나눠 맡습니다',
    keywords: '민락동 치과, 민락 치과, 민락2지구 치과, 민락동 임플란트, 민락 근처 치과, 의정부 민락 치과, 민락역 치과',
    category: '민락동 치과',
    sections: [
      {
        heading: '민락동에서 서울가온치과 오시는 길',
        content: `<p>서울가온치과는 민락동과 맞닿은 용현동, <strong>탑석역 1번 출구에서 도보 약 5분</strong> 거리의 골드자이프라자 4층에 있습니다.</p>
<ul>
<li>🚗 <strong>차량</strong> — 민락동에서 약 5~10분 / 맞은편 제일식자재마트 건물 지하주차장 이용, 진료 후 <strong>무료 주차 쿠폰</strong> 제공</li>
<li>🚌 <strong>버스</strong> — 탑석역·탑석센트럴자이 방면 노선 이용 후 탑석센트럴자이 정류장 하차</li>
<li>🚇 <strong>지하철</strong> — 탑석역 1번 출구에서 걸어서 약 5분</li>
</ul>
<p>📍 주소: <strong>경기도 의정부시 용민로 22, 골드자이프라자 4층(용현동)</strong></p>`
      },
      {
        heading: '민락 주민들이 서울가온치과를 선택하는 이유',
        content: `<ul>
<li><strong>서울대 출신 전문의 2인 진료</strong> — 현진호 대표원장(통합치의학과 전문의, 임플란트·보철) + 조은비 원장(치과보존과 전문의, 신경치료)</li>
<li><strong>CT 기반 가이드 임플란트</strong> — 수술 전에 CT 영상으로 식립 위치를 계획합니다</li>
<li><strong>목요일 야간 ~20:30</strong> — 직장인도 퇴근 후 내원 가능</li>
<li><strong>아이부터 어르신까지</strong> — 소아 실란트·불소도포부터 만 65세 이상 건강보험 임플란트까지 한 곳에서</li>
</ul>
<p>처음 오시면 검사와 촬영을 하고, 사진을 함께 보며 설명을 들으신 뒤 치료 계획과 비용을 서면으로 받아 보시게 됩니다. 비급여 기준 비용은 <a href="/guide">내원 안내</a> 수가표에서 미리 확인하실 수 있습니다.</p>`
      },
      {
        heading: '주요 진료 안내',
        content: `<ul>
<li>🦷 <strong>임플란트</strong> — CT 가이드 수술, 뼈이식, 전체임플란트 / 65세 보험</li>
<li>😁 <strong>교정</strong> — 인비절라인·심미교정·부분교정</li>
<li>✨ <strong>심미</strong> — 라미네이트·레진빌드업·미백·최소삭제 라미네이트</li>
<li>🪥 <strong>일반</strong> — 충치·신경치료·발치·스케일링·사랑니</li>
<li>👶 <strong>소아</strong> — 실란트·불소도포·유치치료</li>
<li>🦴 <strong>보철</strong> — 크라운·브릿지·틀니</li>
</ul>`
      }
    ],
    faqs: [
      { q: '민락동에서 서울가온치과까지 얼마나 걸리나요?', a: '차로 약 5~10분입니다. 맞은편 제일식자재마트 건물 지하주차장에 주차하시면 진료 후 무료 주차 쿠폰을 드립니다. 대중교통으로는 탑석역 1번 출구에서 걸어서 약 5분입니다.' },
      { q: '민락2지구에서 가까운 치과를 찾고 있어요', a: '서울가온치과는 민락동과 맞닿은 용현동, 탑석센트럴자이 정문 맞은편에 있습니다. 임플란트·신경치료·심미·교정·소아 진료를 한 곳에서 받으실 수 있습니다.' },
      { q: '예약 없이 방문해도 되나요?', a: '예약 우선제로 운영하지만, 당일 빈 시간이 있으면 바로 진료 가능합니다. 전화(0507-1325-3377)로 확인 후 방문하시면 대기 시간을 줄일 수 있습니다.' },
    ],
    ctaText: '민락동 → 서울가온치과 상담 예약',
    relatedLinks: [
      { href: '/tapseok-dental', label: '탑석역 치과' },
      { href: '/uijeongbu-dental', label: '의정부 치과 추천' },
      { href: '/implant', label: '임플란트 안내' },
      { href: '/night-dental', label: '야간진료 안내' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
]

// ── 랜딩페이지 콘텐츠 최종 수정일 (고정값) ──
// 각 랜딩 데이터 블록을 실제로 마지막 수정한 커밋 날짜. dateModified·lastReviewed·화면 감수 줄이 모두 이 값을 쓴다.
// "오늘 날짜" 자동 생성 금지 — 해당 랜딩 내용을 고친 날에만 갱신한다.
const LANDING_MODIFIED: Record<string, string> = {
  'uijeongbu-dental': '2026-10-08', 'endodontics': '2026-06-09', 'invisalign': '2026-07-26', 'orthodontics': '2026-07-26',
  'cavity-treatment': '2026-05-26', 'implant-best': '2026-09-03', 'full-mouth-implant': '2026-09-03', 'front-tooth-implant': '2026-06-09',
  'bone-graft-implant': '2026-06-09', 'laminate': '2026-07-26', 'wisdom-tooth': '2026-05-26', 'scaling-gum-treatment': '2026-05-26',
  'denture-to-implant': '2026-05-26', 'implant-cost': '2026-05-26', 'night-dental': '2026-10-08', 'senior-implant': '2026-10-08',
  'emergency-dental': '2026-10-08', 'tapseok-dental': '2026-10-08', 'painless-dental': '2026-05-26', 'pediatric-dental': '2026-05-26',
  'crown': '2026-06-09', 'teeth-whitening': '2026-07-26', 'dental-checkup': '2026-05-26', 'implant-process': '2026-10-08',
  'minrak-dental': '2026-10-08',
}
// 대표 지역 키워드 허브 → MedicalWebPage.about = 병원(@id) + areaServed (2026-10-08 "의정부 치과" 허브)
const LANDING_HUB_AREAS: Record<string, any[]> = {
  'uijeongbu-dental': [
    { "@type": "City", "name": "의정부시", "containedInPlace": { "@type": "State", "name": "경기도" } },
    { "@type": "Place", "name": "의정부시 용현동" },
    { "@type": "Place", "name": "탑석역" },
  ],
}
// 진료(시술) 랜딩 → MedicalProcedure 이름. 여기 있는 페이지는 MedicalWebPage.about=MedicalProcedure + 대표원장 감수 줄을 단다.
const LANDING_PROCEDURES: Record<string, string> = {
  'endodontics': '신경치료', 'invisalign': '인비절라인 투명교정', 'orthodontics': '치아교정', 'cavity-treatment': '충치치료',
  'full-mouth-implant': '전체임플란트', 'front-tooth-implant': '앞니 임플란트', 'bone-graft-implant': '뼈이식 임플란트',
  'laminate': '라미네이트', 'wisdom-tooth': '사랑니 발치', 'scaling-gum-treatment': '스케일링·잇몸치료',
  'pediatric-dental': '소아 치과진료', 'crown': '크라운', 'teeth-whitening': '치아미백',
}

// ── SSR 랜딩페이지 렌더러 ──
function renderLandingPage(page: LandingPageData): string {
  const canonicalUrl = `${SITE}/${page.slug}`
  const modified = LANDING_MODIFIED[page.slug]
  const procName = LANDING_PROCEDURES[page.slug]
  const procedureId = `${canonicalUrl}#procedure`

  // JSON-LD: MedicalWebPage (병원·웹사이트·의료진은 @id 참조 — 전체 정의는 홈)
  const jsonLdPage: any = {
    "@context": "https://schema.org",
    "@type": "MedicalWebPage",
    "@id": `${canonicalUrl}#webpage`,
    "name": page.h1,
    "description": page.metaDesc,
    "url": canonicalUrl,
    "inLanguage": "ko",
    "isPartOf": WEBSITE_REF,
    "about": procName ? { "@id": procedureId } : (LANDING_HUB_AREAS[page.slug] ? CLINIC_REF : { "@type": "MedicalSpecialty", "name": page.category }),
    ...(LANDING_HUB_AREAS[page.slug] ? { "areaServed": LANDING_HUB_AREAS[page.slug], "mainEntity": CLINIC_REF } : {}),
    ...(modified ? { "dateModified": modified } : {}),
    "publisher": CLINIC_REF,
    "speakable": {
      "@type": "SpeakableSpecification",
      "cssSelector": ["h1", ".landing-section h2", ".landing-section p"]
    }
  }
  if (procName) {
    jsonLdPage.reviewedBy = DOCTOR_HYUN_REF
    if (modified) jsonLdPage.lastReviewed = modified
  }
  // JSON-LD: MedicalProcedure (진료 랜딩만)
  const jsonLdProcedure = procName ? {
    "@context": "https://schema.org",
    "@type": "MedicalProcedure",
    "@id": procedureId,
    "name": procName,
    "description": page.metaDesc,
    "url": canonicalUrl,
    "provider": { "@id": CLINIC_ID },
  } : null
  const reviewLineHtml = procName && modified
    ? `<p class="landing-review" style="margin:0 0 2.5rem;font-size:.82rem;color:var(--stone-l)">감수: <a href="/doctors" style="color:var(--gold)">현진호 대표원장</a>(통합치의학과 전문의) · 최종 검토 <time datetime="${modified}">${modified}</time></p>`
    : ''

  // JSON-LD: FAQPage
  const jsonLdFaq = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": page.faqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }))
  }

  // JSON-LD: BreadcrumbList
  const jsonLdBreadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "홈", "item": SITE },
      { "@type": "ListItem", "position": 2, "name": page.h1, "item": canonicalUrl }
    ]
  }

  // 섹션 HTML
  const sectionsHtml = page.sections.map((s, i) => `
    <section class="landing-section" ${i === 0 ? '' : ''}>
      <h2>${s.heading}</h2>
      <div class="landing-content">${s.content}</div>
    </section>
  `).join('')

  // FAQ HTML (SEO + 사용자 경험) — 구조화 데이터는 JSON-LD FAQPage 한 벌만 (마이크로데이터 중복 제거 2026-09-29)
  const faqHtml = page.faqs.map((f, i) => `
    <div class="faq-item">
      <button class="faq-q" aria-expanded="false" onclick="this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',this.parentElement.classList.contains('open'))">
        <span>${escHtml(f.q)}</span>
        <i class="fas fa-chevron-down"></i>
      </button>
      <div class="faq-a">
        <div><p>${escHtml(f.a)}</p></div>
      </div>
    </div>
  `).join('')

  // 내부 링크 섹션
  const linksHtml = page.relatedLinks.map(l =>
    `<a href="${l.href}" class="related-link"><i class="fas fa-chevron-right"></i> ${escHtml(l.label)}</a>`
  ).join('')

  // OG 이미지 차별화 — 카테고리/슬러그별 적절한 이미지 매핑
  const ogImageMap: Record<string, string> = {
    'implant': '/images/clinic-implant-center.jpg',
    'implant-best': '/images/clinic-implant-center.jpg',
    'implant-cost': '/images/clinic-consult-room.jpg',
    'full-mouth-implant': '/images/clinic-implant-center.jpg',
    'front-tooth-implant': '/images/clinic-treatment.jpg',
    'bone-graft-implant': '/images/clinic-implant-center.jpg',
    'senior-implant': '/images/clinic-consult.jpg',
    'denture-to-implant': '/images/clinic-consult.jpg',
    'aesthetic': '/images/clinic-makeup-close.jpg',
    'resin-buildup': '/images/clinic-makeup.jpg',
    'laminate': '/images/clinic-makeup-close.jpg',
    'invisalign': '/images/clinic-treatment.jpg',
    'orthodontics': '/images/clinic-treatment.jpg',
    'endodontics': '/images/clinic-unit-1.jpg',
    'cavity-treatment': '/images/clinic-unit-1.jpg',
    'wisdom-tooth': '/images/clinic-treatment.jpg',
    'scaling-gum-treatment': '/images/clinic-unit-1.jpg',
    'uijeongbu-dental': '/images/clinic-lobby-1.jpg',
    'tapseok-dental': '/images/clinic-lobby-2.jpg',
    'night-dental': '/images/clinic-waiting.jpg',
    'emergency-dental': '/images/clinic-treatment.jpg',
    'painless-dental': '/images/clinic-consult-room.jpg',
    'pediatric-dental': '/images/clinic-consult.jpg',
    'crown': '/images/clinic-treatment.jpg',
    'teeth-whitening': '/images/clinic-makeup-close.jpg',
    'dental-checkup': '/images/clinic-unit-1.jpg',
    'implant-process': '/images/clinic-implant-center.jpg',
    'minrak-dental': '/images/clinic-lobby-1.jpg',
  }
  const ogImage = `${SITE}${ogImageMap[page.slug] || '/images/og-main.jpg'}`

  return `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>${escHtml(page.title)}</title>
<meta name="description" content="${escHtml(page.metaDesc)}">
<meta name="keywords" content="${escHtml(page.keywords)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
<meta name="author" content="서울가온치과의원">
<link rel="canonical" href="${canonicalUrl}">
<link rel="alternate" hreflang="ko" href="${canonicalUrl}">
<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="서울가온치과">
<meta property="og:title" content="${escHtml(page.title)}">
<meta property="og:description" content="${escHtml(page.metaDesc)}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:image" content="${ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="ko_KR">
<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(page.title)}">
<meta name="twitter:description" content="${escHtml(page.metaDesc)}">
<meta name="twitter:image" content="${ogImage}">
<!-- JSON-LD -->
<script type="application/ld+json">${JSON.stringify(jsonLdPage)}</script>
${jsonLdProcedure ? `<script type="application/ld+json">${JSON.stringify(jsonLdProcedure)}</script>\n` : ''}<script type="application/ld+json">${JSON.stringify(jsonLdFaq)}</script>
<script type="application/ld+json">${JSON.stringify(jsonLdBreadcrumb)}</script>
<style>
.landing-hero{padding:clamp(10rem,18vh,14rem) clamp(1.5rem,4vw,3rem) clamp(3rem,6vh,5rem);text-align:center;max-width:800px;margin:0 auto}
.landing-hero h1{font-family:var(--ff-title);font-weight:500;font-size:clamp(1.8rem,4.5vw,2.8rem);color:var(--ivory);line-height:1.3;margin-bottom:1rem}
.landing-hero-sub{font-size:clamp(.9rem,1.2vw,1.05rem);color:var(--stone-l);line-height:1.8;margin-bottom:2rem}
.landing-cta-row{display:flex;gap:1rem;justify-content:center;flex-wrap:wrap}
.landing-cta{display:inline-flex;align-items:center;gap:.5rem;padding:.8rem 2rem;border-radius:100px;font-size:.9rem;font-weight:600;text-decoration:none;transition:all .3s}
.landing-cta-primary{background:var(--gold);color:var(--ink)}
.landing-cta-primary:hover{background:var(--gold-b)}
.landing-cta-secondary{border:1px solid var(--gold);color:var(--gold)}
.landing-cta-secondary:hover{background:var(--gold);color:var(--ink)}
.landing-body{max-width:800px;margin:0 auto;padding:0 clamp(1.5rem,4vw,3rem) clamp(4rem,8vh,6rem)}
.landing-section{margin-bottom:3rem}
.landing-section h2{font-family:var(--ff-title);font-weight:500;font-size:clamp(1.2rem,2.5vw,1.6rem);color:var(--ivory);margin-bottom:1rem;padding-bottom:.5rem;border-bottom:1px solid rgba(191,164,106,.12)}
.landing-content{font-size:clamp(.88rem,1vw,.96rem);line-height:2;color:var(--stone-l);word-break:keep-all}
.landing-content p{margin-bottom:1rem}
.landing-content strong{color:var(--ivory);font-weight:600}
.landing-content ul,.landing-content ol{margin:1rem 0 1.5rem 1.2rem;line-height:1.9}
.landing-content li{margin-bottom:.5rem}
.landing-content li::marker{color:var(--gold)}
.landing-content a{color:var(--gold);text-decoration:underline;text-underline-offset:3px}
.landing-faq{margin-bottom:3rem}
.landing-faq h2{font-family:var(--ff-title);font-weight:500;font-size:clamp(1.2rem,2.5vw,1.6rem);color:var(--ivory);margin-bottom:1.5rem;padding-bottom:.5rem;border-bottom:1px solid rgba(191,164,106,.12)}
.faq-item{border:1px solid var(--line);border-radius:12px;margin-bottom:.75rem;overflow:hidden;transition:border-color .3s}
.faq-item.open{border-color:rgba(191,164,106,.3)}
.faq-q{width:100%;text-align:left;padding:1rem 1.25rem;font-size:.92rem;color:var(--ivory);font-weight:500;display:flex;justify-content:space-between;align-items:center;gap:1rem;cursor:pointer;background:none;border:none;font-family:inherit}
.faq-q i{color:var(--gold);font-size:.7rem;transition:transform .3s}
.faq-item.open .faq-q i{transform:rotate(180deg)}
.faq-a{max-height:0;overflow:hidden;transition:max-height .4s ease,padding .3s}
.faq-item.open .faq-a{max-height:400px;padding:0 1.25rem 1rem}
.faq-a p{font-size:.88rem;color:var(--stone-l);line-height:1.8}
.landing-links{margin-bottom:3rem}
.landing-links h3{font-family:var(--ff-title);font-weight:500;font-size:1rem;color:var(--stone-l);margin-bottom:1rem;letter-spacing:.05em}
.related-link{display:inline-flex;align-items:center;gap:.4rem;padding:.5rem 1.2rem;border:1px solid var(--line);border-radius:100px;font-size:.82rem;color:var(--stone-l);text-decoration:none;transition:all .3s;margin:0 .5rem .5rem 0}
.related-link:hover{border-color:var(--gold);color:var(--gold)}
.related-link i{font-size:.6rem}
.landing-bottom-cta{text-align:center;padding:3rem 1.5rem;border-top:1px solid var(--line)}
.landing-bottom-cta p{font-size:.9rem;color:var(--stone-l);margin-bottom:1.5rem}
@media(max-width:768px){
  .landing-hero{padding:7rem 1.25rem 2rem}
  .landing-hero h1{font-size:clamp(1.5rem,6vw,2rem)}
  .landing-body{padding:0 1.25rem 3rem}
  .landing-cta-row{flex-direction:column;align-items:stretch}
  .landing-cta{justify-content:center;min-height:48px}
  .faq-q{padding:.85rem 1rem;font-size:.88rem}
}
</style>
</head>
<body>
<noscript><div style="background:#BFA46A;color:#050504;padding:1rem;text-align:center;font-weight:600">이 웹사이트는 JavaScript가 필요합니다.</div></noscript>
${NAV_HTML}
<main id="main-content" role="main">
  <div class="landing-hero">
    <h1>${page.h1}</h1>
    <p class="landing-hero-sub">${escHtml(page.heroSub)}</p>
    <div class="landing-cta-row">
      <a href="tel:0507-1325-3377" class="landing-cta landing-cta-primary"><i class="fas fa-phone"></i> ${escHtml(page.ctaText)}</a>
      <a href="https://pf.kakao.com/_LLxhwG/chat" target="_blank" rel="noopener" class="landing-cta landing-cta-secondary"><i class="fas fa-comment"></i> 카카오톡 상담</a>
    </div>
  </div>
  <div class="landing-body">
    ${sectionsHtml}
    ${reviewLineHtml}
    <div class="landing-faq">
      <h2>자주 묻는 질문</h2>
      ${faqHtml}
    </div>
    <div class="landing-links">
      <h3>관련 진료 안내</h3>
      ${linksHtml}
    </div>
    <div class="landing-bottom-cta">
      <p>궁금한 점이 있으시면 언제든지 상담해 주세요.</p>
      <a href="tel:0507-1325-3377" class="landing-cta landing-cta-primary"><i class="fas fa-phone"></i> 전화 상담: 0507-1325-3377</a>
    </div>
  </div>
</main>
${FOOTER_HTML}
${KAKAO_FLOAT}
<script src="/pages.js"></script>
<script>
var ham=document.querySelector('.hamburger'),mob=document.querySelector('.mob-menu');
if(ham&&mob){ham.addEventListener('click',function(){ham.classList.toggle('open');mob.classList.toggle('open')});mob.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){ham.classList.remove('open');mob.classList.remove('open')})})}
</script>
</body>
</html>`
}

// ══════════════════════════════════════════════════
//  비급여 수가표 (FEE SCHEDULE) — 원장 편집 + 항목별 공개/비공개
//  · 공개 페이지: /guide (#fee) — 정적 guide.html 의 fee 표를 DB(공개 항목)로 치환
//  · 데이터 없으면 정적 표 그대로 노출 → 절대 빈 화면 없음
//  · 관리자: GET/POST /api/admin/fees (auth 필요)
//  seed 출처: public/guide.html #fee (실제 게시 중이던 수가표)
// ══════════════════════════════════════════════════
type FeeSeedItem = { category: string; name: string; price: string; note: string; is_nhi?: number }
const FEE_SEED: FeeSeedItem[] = [
  // 임플란트
  { category: '임플란트', name: '오스템 SOI', price: '100만원', note: '프리미엄 픽스쳐' },
  { category: '임플란트', name: '오스템 SA', price: '90만원', note: '' },
  { category: '임플란트', name: '덴티스', price: '80만원', note: '' },
  { category: '임플란트', name: '단순 뼈이식', price: '30만원', note: '' },
  { category: '임플란트', name: '복잡 뼈이식', price: '50만원', note: '' },
  { category: '임플란트', name: '완전 복잡 뼈이식', price: '80만원', note: '' },
  { category: '임플란트', name: '상악동 거상술 (Crestal)', price: '50만원', note: '폐쇄형' },
  { category: '임플란트', name: '상악동 거상술 (Lateral)', price: '80만원', note: '개방형' },
  { category: '임플란트', name: '네비게이션 (치아당)', price: '10~5만원', note: '가이드 수술' },
  { category: '임플란트', name: '전치부 추가', price: '10만원 추가', note: '앞니 부위' },
  { category: '임플란트', name: '커스텀 어버트먼트', price: '20만원', note: '' },
  { category: '임플란트', name: '만 65세 이상 임플란트', price: '본인부담 약 30~50만원', note: '건강보험 적용 (2개)', is_nhi: 1 },
  // 보존 (레진 치료)
  { category: '보존 (레진 치료)', name: '구치부 레진 1면', price: '10만원', note: '어금니 · 단순' },
  { category: '보존 (레진 치료)', name: '구치부 레진 2면', price: '15만원', note: '어금니 · 복합' },
  { category: '보존 (레진 치료)', name: '전치부 레진 (간단)', price: '10만원', note: '앞니 · 단순' },
  { category: '보존 (레진 치료)', name: '전치부 레진 (복잡)', price: '15만원', note: '앞니 · 복합' },
  { category: '보존 (레진 치료)', name: 'Diastema (치아당)', price: '25만원', note: '치아 사이 벌어짐' },
  { category: '보존 (레진 치료)', name: 'Pit 레진', price: '5만원', note: '미세 홈 충전' },
  { category: '보존 (레진 치료)', name: '치경부 레진', price: '7만원', note: '잇몸 경계부 마모' },
  { category: '보존 (레진 치료)', name: '유치 레진', price: '5만원', note: '소아' },
  { category: '보존 (레진 치료)', name: '임플란트 홀 레진', price: '5만원', note: '타원형 홀 충전' },
  { category: '보존 (레진 치료)', name: '레진 코어', price: '5만원', note: '크라운 기둥' },
  // 레진 빌드업
  { category: '레진 빌드업', name: '1급', price: '40만원', note: '' },
  { category: '레진 빌드업', name: '2급', price: '50만원', note: '' },
  { category: '레진 빌드업', name: '3급', price: '60만원', note: '' },
  // 보철
  { category: '보철', name: '이맥스 인레이', price: '30 / 35만원', note: '크기에 따라 상이' },
  { category: '보철', name: '골드 인레이', price: '60만원', note: '' },
  { category: '보철', name: '지르코니아 크라운 (구치)', price: '45만원', note: '어금니' },
  { category: '보철', name: '지르코니아 크라운 (전치)', price: '60만원', note: '앞니 · 심미' },
  { category: '보철', name: '라미네이트', price: '60만원', note: '앞니 전용' },
  { category: '보철', name: 'PFM 크라운 (구치)', price: '40만원', note: '도재 금속관' },
  { category: '보철', name: 'PFZ 크라운', price: '65만원', note: '도재 지르코니아' },
  { category: '보철', name: '골드 크라운', price: '100만원', note: '' },
  // 기타 진료
  { category: '기타 진료', name: '임시 틀니 (악당)', price: '30만원', note: '' },
  { category: '기타 진료', name: '전체 틀니 (악당)', price: '200만원', note: '' },
  { category: '기타 진료', name: '부분 틀니 (악당)', price: '170만원', note: '' },
  { category: '기타 진료', name: '플리퍼', price: '10만원', note: '임시 부분 의치' },
  { category: '기타 진료', name: 'SS 크라운', price: '10만원', note: '소아 기성관' },
  { category: '기타 진료', name: '공간유지장치', price: '15만원', note: '소아' },
  { category: '기타 진료', name: '불소 도포', price: '3만원', note: '' },
  { category: '기타 진료', name: '보톡스', price: '5만원', note: '부가세 별도' },
  { category: '기타 진료', name: '오피스 미백', price: '20만원', note: '부가세 별도' },
  { category: '기타 진료', name: '비급여 스케일링', price: '5만원', note: '보험 외 추가' },
  { category: '기타 진료', name: '스케일링', price: '본인부담 약 1.5만원', note: '연 1회 보험', is_nhi: 1 },
  // 제증명서류
  { category: '제증명서류', name: '상해진단서', price: '상급병원 의뢰', note: '' },
  { category: '제증명서류', name: '진료확인서 (질별코드X)', price: '3천원', note: '' },
  { category: '제증명서류', name: '진단서', price: '1만원', note: '' },
  { category: '제증명서류', name: '수술확인서', price: '1만원', note: '' },
  { category: '제증명서류', name: '사보험 치과치료확인서', price: '3천원', note: '' },
  { category: '제증명서류', name: '방사선 사진', price: '5천원', note: '' },
]

let feesReady = false
async function ensureFees(db: D1Database) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS fee_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL DEFAULT '기타',
    name TEXT NOT NULL,
    price TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    is_nhi INTEGER NOT NULL DEFAULT 0,
    is_published INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`).run()
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_fee_pub ON fee_items(is_published, sort_order)`).run() } catch {}
  // seed (테이블이 비어있을 때만)
  const cnt: any = await db.prepare('SELECT COUNT(*) AS n FROM fee_items').first()
  if (!cnt || cnt.n === 0) {
    const stmt = db.prepare('INSERT INTO fee_items (category, name, price, note, is_nhi, is_published, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)')
    const batch = FEE_SEED.map((it, i) => stmt.bind(it.category, it.name, it.price, it.note, it.is_nhi ? 1 : 0, i))
    await db.batch(batch)
  }
  feesReady = true
}

// 공개(is_published=1) 항목으로 fee-table <tbody> 내부 행 생성. 항목이 없으면 null 반환(정적표 유지).
async function renderPublishedFeeRows(db: D1Database): Promise<string | null> {
  try {
    await ensureFees(db)
    const rs = await db.prepare('SELECT category, name, price, note, is_nhi FROM fee_items WHERE is_published = 1 ORDER BY sort_order ASC, id ASC').all()
    const items: any[] = (rs.results as any[]) || []
    if (!items.length) return null
    let out = ''
    let cur = ''
    for (const it of items) {
      if (it.category !== cur) {
        cur = it.category
        out += `        <tr class="fee-cat-row"><td class="fee-cat" colspan="3">${escHtml(cur)}</td></tr>\n`
      }
      const badge = it.is_nhi ? ' <span class="fee-badge nhi">건보</span>' : ''
      out += `        <tr><td>${escHtml(it.name)}${badge}</td><td class="price">${escHtml(it.price)}</td><td>${escHtml(it.note || '')}</td></tr>\n`
    }
    return out
  } catch (e) {
    return null
  }
}

// 공개 페이지: /guide — 정적 guide.html 을 그대로 서빙하되 수가표만 DB(공개항목)로 치환
app.get('/guide', async (c) => {
  const assetRes = await c.env.ASSETS.fetch(c.req.raw)
  try {
    let html = await assetRes.text()
    const rows = await renderPublishedFeeRows(c.env.DB)
    if (rows && /<tbody>[\s\S]*?<\/tbody>/.test(html)) {
      html = html.replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>\n${rows}      </tbody>`)
    }
    return c.html(html)
  } catch (e) {
    // 실패 시 원본 정적 페이지 그대로 (절대 빈 화면 없음)
    return c.env.ASSETS.fetch(c.req.raw)
  }
})

// 공개 페이지: /notice — 정적 notice.html 에 공지 목록을 서버에서 채워 넣음 (2026-09-29)
// 예전엔 fetch('/api/notices')로만 그려서 robots.txt 가 /api/ 를 막는 검색엔진에는 빈 목록만 보였다.
// 공지 본문 합이 300자 미만이면 noindex, follow + 사이트맵 제외 (공지가 쌓이면 자동 복귀).
const THIN_NOTICE_LIST_MIN_CHARS = 300
async function loadPublishedNotices(db: D1Database): Promise<any[]> {
  const rs = await db.prepare('SELECT id, title, content, is_pinned, created_at FROM notices WHERE is_published = 1 ORDER BY is_pinned DESC, created_at DESC LIMIT 50').all()
  return (rs.results as any[]) || []
}
function isThinNoticeList(notices: any[]): boolean {
  const len = notices.reduce((n, x) => n + plainTextLength(x.title) + plainTextLength(x.content), 0)
  return len < THIN_NOTICE_LIST_MIN_CHARS
}
app.get('/notice', async (c) => {
  const assetRes = await c.env.ASSETS.fetch(c.req.raw)
  try {
    let html = await assetRes.text()
    const db = c.env.DB
    const notices = await loadPublishedNotices(db)
    const imagesBy: Record<string, any[]> = {}
    if (notices.length) {
      try {
        const ids = notices.map((n) => Number(n.id)).filter((n) => Number.isFinite(n)).join(',')
        const imgs = await db.prepare(`SELECT notice_id, image_url, sort_order FROM notice_images WHERE notice_id IN (${ids}) ORDER BY sort_order`).all()
        for (const im of ((imgs.results as any[]) || [])) (imagesBy[String(im.notice_id)] ||= []).push(im)
      } catch { /* 이미지 테이블 스키마 차이 — 본문만 렌더 */ }
    }
    const items = notices.length
      ? notices.map((n) => {
          const imgs = imagesBy[String(n.id)] || []
          const badge = `<span class="notice-badge">${n.is_pinned ? '공지' : '새 글'}</span>`
          const gallery = imgs.length
            ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-top:1rem">' +
              imgs.map((im) => `<img src="${escHtml(String(im.image_url || ''))}" alt="${escHtml(String(n.title || ''))} 이미지" loading="lazy" style="width:100%;border-radius:8px;cursor:pointer;aspect-ratio:4/3;object-fit:cover" onclick="openNoticeImg(this.src)">`).join('') +
              '</div>'
            : ''
          const body = escHtml(String(n.content || '')).replace(/\n/g, '<br>')
          return `<div class="notice-item">
    <button class="notice-q"${n.is_pinned ? ' data-open' : ''}>
      <span>${badge}${escHtml(String(n.title || ''))}</span>
      <span class="plus">+</span>
    </button>
    <div class="notice-a"><div class="notice-a-inner">${body}${gallery}</div></div>
  </div>`
        }).join('\n')
      : '<div style="padding:3rem;text-align:center;color:var(--stone,#888)">등록된 공지사항이 없습니다.</div>'
    html = html.replace(/<div class="notice-list" id="notice-list">[\s\S]*?<\/div>/, `<div class="notice-list" id="notice-list" data-ssr="1">\n${items}\n</div>`)
    const thin = isThinNoticeList(notices)
    if (thin) html = html.replace(/<meta name="robots"[^>]*>/i, '').replace('</head>', '<meta name="robots" content="noindex, follow">\n</head>')
    return c.html(html, 200, thin ? { 'X-Robots-Tag': 'noindex, follow' } : {})
  } catch (e) {
    // 실패 시 원본 정적 페이지 그대로 (클라이언트가 /api/notices 로 그림)
    return c.env.ASSETS.fetch(c.req.raw)
  }
})

// 공개 API: 공개 항목만 (카테고리별 그룹)
app.get('/api/fees', async (c) => {
  try {
    await ensureFees(c.env.DB)
    const rs = await c.env.DB.prepare('SELECT id, category, name, price, note, is_nhi FROM fee_items WHERE is_published = 1 ORDER BY sort_order ASC, id ASC').all()
    return c.json({ items: rs.results || [] })
  } catch (e: any) {
    return c.json({ items: [], error: e.message }, 200)
  }
})

// 관리자: 전체 항목 조회 (비공개 포함)
app.get('/api/admin/fees', auth, async (c) => {
  await ensureFees(c.env.DB)
  const rs = await c.env.DB.prepare('SELECT id, category, name, price, note, is_nhi, is_published, sort_order FROM fee_items ORDER BY sort_order ASC, id ASC').all()
  return c.json({ items: rs.results || [] })
})

// 관리자: 전체 저장 (추가/수정/삭제/공개토글/순서 일괄 반영 — 전체 교체)
app.post('/api/admin/fees', auth, async (c) => {
  try {
    await ensureFees(c.env.DB)
    const body = await c.req.json<{ items: any[] }>()
    const items = Array.isArray(body?.items) ? body.items : null
    if (!items) return c.json({ error: '항목 목록이 필요합니다' }, 400)
    const clean = items
      .map((it: any) => ({
        category: String(it.category ?? '기타').trim() || '기타',
        name: String(it.name ?? '').trim(),
        price: String(it.price ?? '').trim(),
        note: String(it.note ?? '').trim(),
        is_nhi: it.is_nhi ? 1 : 0,
        is_published: it.is_published === 0 || it.is_published === false ? 0 : 1,
      }))
      .filter((it) => it.name.length > 0)
    const db = c.env.DB
    const ops: any[] = [db.prepare('DELETE FROM fee_items')]
    const ins = db.prepare('INSERT INTO fee_items (category, name, price, note, is_nhi, is_published, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)')
    clean.forEach((it, i) => ops.push(ins.bind(it.category, it.name, it.price, it.note, it.is_nhi, it.is_published, i)))
    await db.batch(ops)
    return c.json({ ok: true, count: clean.length, published: clean.filter((x) => x.is_published).length })
  } catch (e: any) {
    return c.json({ error: '저장 실패: ' + e.message }, 500)
  }
})

// ── 각 랜딩페이지에 대해 라우트 등록 ──
for (const page of LANDING_PAGES) {
  app.get(`/${page.slug}`, async (c) => {
    let html = renderLandingPage(page)
    // 진료 랜딩 ↔ 칼럼 내부 링크: 이 진료로 연결되는 최신 칼럼 5편 (카테고리·제목 키워드, 얇은 글·중복본 제외) — 2026-10-03
    const txPath = `/${page.slug}`
    if (SEO_TX_PAGES.some((t) => t.path === txPath)) {
      try {
        const rows = await c.env.DB.prepare(`SELECT id, title, category, content FROM blog_posts WHERE is_published = 1 AND id NOT IN (${BLOG_DUPLICATE_IDS_SQL}) ORDER BY created_at DESC LIMIT 300`).all()
        const hits = ((rows.results || []) as any[]).filter((r) => !isThinBlogPost(r) && seoTxFor(r.category, r.title).some((t) => t.path === txPath)).slice(0, 5)
        if (hits.length) {
          const sec = `<section class="sg-related" aria-label="관련 칼럼" style="max-width:1100px;margin:0 auto;padding:2rem clamp(1.25rem,4vw,3rem) 3rem"><style>${SEO_BOX_CSS}</style>
  <h2>${escHtml(LANDING_PROCEDURES[page.slug] || page.h1)} 관련 칼럼</h2>
  <ul class="sg-list">${hits.map((r) => `<li><a href="/blog/${r.id}">${escHtml(r.title)}</a></li>`).join('')}</ul>
  <p style="margin-top:1rem"><a href="/blog" style="color:var(--gold,#BFA46A)">칼럼 전체 보기 →</a></p>
</section>`
          html = html.replace('</main>', `${sec}\n</main>`)
        }
      } catch { /* DB 없어도 랜딩은 정상 */ }
    }
    return c.html(html, 200, {
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200',
      'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
    })
  })
}

// ══════════════════════════════════════════════════
//  LEGACY REDIRECT: /glownate → /laminate (301)
//  글로우네이트(서울비디치과 브랜드) URL 제거 — 기존 색인/방문자 라미네이트로 영구 이전
// ══════════════════════════════════════════════════
app.get('/glownate', (c) => c.redirect('/laminate', 301))

// ══════════════════════════════════════════════════
//  STATIC FILES (must be last)
// ══════════════════════════════════════════════════
app.use('/*', serveStatic())

export default app
