import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-pages'

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

// SEO & Security Headers — 모든 응답에 적용
app.use('*', async (c, next) => {
  await next()
  const url = new URL(c.req.url)
  const path = url.pathname

  // 보안 헤더
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'SAMEORIGIN')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)')

  // HTML 페이지 캐시: 짧게 (SEO 크롤러가 최신 콘텐츠 수집)
  if (path === '/' || path.match(/^\/(treatments|doctors|philosophy|guide|faq|blog|notice|encyclopedia|before-after|signup|community|reservation|aesthetic|resin-buildup|implant|uijeongbu-dental|endodontics|invisalign|orthodontics|glownate|cavity-treatment|implant-best|full-mouth-implant|front-tooth-implant|bone-graft-implant|laminate|wisdom-tooth|scaling-gum-treatment|denture-to-implant|implant-cost|night-dental|senior-implant|emergency-dental|tapseok-dental|painless-dental)$/) || path.match(/^\/(blog|before-after)\/\d+$/)) {
    c.header('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200')
    c.header('X-Robots-Tag', 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1')
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
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    if (obj.etag) headers.set('ETag', obj.etag)

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
    const blogs = await db.prepare('SELECT id, title, category, thumbnail_url, created_at FROM blog_posts WHERE doctor_id = ? AND is_published = 1 ORDER BY created_at DESC LIMIT 10').bind(id).all()
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

    let whereParts = ['b.is_published = 1']
    const binds: any[] = []

    if (category) { whereParts.push('b.category = ?'); binds.push(category) }
    if (search) { whereParts.push('(b.title LIKE ? OR b.content LIKE ?)'); binds.push(`%${search}%`, `%${search}%`) }
    if (doctorId) { whereParts.push('b.doctor_id = ?'); binds.push(doctorId) }

    const where = whereParts.join(' AND ')
    const dataSql = `SELECT b.id, b.title, b.content, b.category, b.doctor_id, b.thumbnail_url, b.view_count, b.created_at, d.name as doctor_name, d.photo_url as doctor_photo FROM blog_posts b LEFT JOIN doctors d ON b.doctor_id = d.id WHERE ${where} ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as total FROM blog_posts b WHERE ${where.replace(/d\./g, '').replace(/LEFT JOIN.*?WHERE/, 'WHERE')}`
    // Simpler count
    let countWhereParts = ['is_published = 1']
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
    c.executionCtx.waitUntil(submitIndexNow([`https://seoulgaondc.kr/before-after/${caseId}`, 'https://seoulgaondc.kr/before-after', 'https://seoulgaondc.kr/sitemap.xml']))

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
    c.executionCtx.waitUntil(submitIndexNow([`https://seoulgaondc.kr/before-after/${id}`, 'https://seoulgaondc.kr/before-after']))

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
    const slug = d.slug?.trim() || d.term.trim().toLowerCase().replace(/[^가-힣a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const exists = await db.prepare('SELECT id FROM encyclopedia WHERE slug = ?').bind(slug).first()
    if (exists) return c.json({ error: '이미 존재하는 slug입니다' }, 409)
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
    return c.json({ id: result.meta.last_row_id, slug }, 201)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.put('/api/admin/encyclopedia/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const d = await c.req.json<any>()
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
//  DYNAMIC SITEMAP.XML — 블로그·공지 개별 URL 자동 포함
// ══════════════════════════════════════════════════
app.get('/sitemap.xml', async (c) => {
  try {
    const db = c.env.DB
    const SITE = 'https://seoulgaondc.kr'
    const today = new Date().toISOString().split('T')[0]

    // ── 정적 페이지 ──
    const staticPages = [
      { loc: '/',               priority: '1.0',  changefreq: 'weekly',  lastmod: today },
      { loc: '/implant',        priority: '1.0',  changefreq: 'weekly',  lastmod: today },
      { loc: '/treatments',     priority: '0.95', changefreq: 'monthly', lastmod: today },
      { loc: '/aesthetic',       priority: '0.95', changefreq: 'monthly', lastmod: today },
      { loc: '/resin-buildup',   priority: '0.95', changefreq: 'monthly', lastmod: today },
      { loc: '/philosophy',     priority: '0.9',  changefreq: 'monthly', lastmod: '2026-04-09' },
      { loc: '/doctors',        priority: '0.9',  changefreq: 'monthly', lastmod: today },
      { loc: '/guide',          priority: '0.85', changefreq: 'monthly', lastmod: '2026-04-09' },
      { loc: '/faq',            priority: '0.85', changefreq: 'weekly',  lastmod: '2026-04-09' },
      { loc: '/encyclopedia',   priority: '0.8',  changefreq: 'monthly', lastmod: '2026-04-09' },
      { loc: '/blog',           priority: '0.85', changefreq: 'daily',   lastmod: today },
      { loc: '/before-after',   priority: '0.85', changefreq: 'daily',   lastmod: today },
      { loc: '/notice',         priority: '0.6',  changefreq: 'weekly',  lastmod: today },
      { loc: '/community',      priority: '0.8',  changefreq: 'weekly',  lastmod: today },
      { loc: '/reservation',    priority: '0.9',  changefreq: 'monthly', lastmod: '2026-04-09' },
      // 지역명+핵심진료 SEO 랜딩페이지
      { loc: '/uijeongbu-dental', priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/endodontics',      priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/invisalign',       priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/orthodontics',     priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/glownate',         priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/cavity-treatment', priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/implant-best',         priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/full-mouth-implant',   priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/front-tooth-implant',  priority: '0.90', changefreq: 'weekly',  lastmod: today },
      { loc: '/bone-graft-implant',   priority: '0.90', changefreq: 'weekly',  lastmod: today },
      { loc: '/laminate',             priority: '0.90', changefreq: 'weekly',  lastmod: today },
      { loc: '/wisdom-tooth',         priority: '0.85', changefreq: 'weekly',  lastmod: today },
      { loc: '/scaling-gum-treatment',priority: '0.85', changefreq: 'weekly',  lastmod: today },
      { loc: '/denture-to-implant',   priority: '0.90', changefreq: 'weekly',  lastmod: today },
      { loc: '/implant-cost',         priority: '0.95', changefreq: 'weekly',  lastmod: today },
      { loc: '/night-dental',         priority: '0.85', changefreq: 'weekly',  lastmod: today },
      { loc: '/senior-implant',       priority: '0.90', changefreq: 'weekly',  lastmod: today },
      { loc: '/emergency-dental',     priority: '0.85', changefreq: 'weekly',  lastmod: today },
      { loc: '/tapseok-dental',       priority: '0.85', changefreq: 'weekly',  lastmod: today },
      { loc: '/painless-dental',      priority: '0.85', changefreq: 'weekly',  lastmod: today },
    ]

    // ── 블로그 포스트 (개별 URL — 클린 URL) ──
    let blogPosts: any[] = []
    try {
      const blogResult = await runQuery(db,
        `SELECT id, title, created_at, updated_at FROM blog_posts WHERE is_published = 1 ORDER BY created_at DESC`, [])
      blogPosts = blogResult.results || []
    } catch (e) { /* ignore */ }

    // ── 비포&애프터 (개별 URL — SSR 상세 페이지) ──
    let baCases: any[] = []
    try {
      const baResult = await runQuery(db,
        `SELECT id, title, created_at, updated_at FROM before_after WHERE is_published = 1 ORDER BY created_at DESC`, [])
      baCases = baResult.results || []
    } catch (e) { /* ignore */ }

    // ── 공지사항 (개별 URL) ──
    let notices: any[] = []
    try {
      const noticeResult = await runQuery(db,
        `SELECT id, title, created_at FROM notices WHERE is_published = 1 ORDER BY created_at DESC`, [])
      notices = noticeResult.results || []
    } catch (e) { /* ignore */ }

    // ── XML 생성 ──
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`

    // 정적 페이지
    for (const p of staticPages) {
      xml += `  <url>
    <loc>${SITE}${p.loc}</loc>
    <lastmod>${p.lastmod}</lastmod>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>\n`
    }

    // 블로그 개별 포스트 (클린 URL: /blog/:id)
    for (const post of blogPosts) {
      const date = (post.updated_at || post.created_at || today).toString().split('T')[0].split(' ')[0]
      xml += `  <url>
    <loc>${SITE}/blog/${post.id}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.75</priority>
  </url>\n`
    }

    // 비포&애프터 개별 케이스 (클린 URL: /before-after/:id)
    for (const ba of baCases) {
      const date = (ba.updated_at || ba.created_at || today).toString().split('T')[0].split(' ')[0]
      xml += `  <url>
    <loc>${SITE}/before-after/${ba.id}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.75</priority>
  </url>\n`
    }

    // 공지사항 개별 (notice 페이지에서 모달로 표시하므로 앵커 형태)
    for (const n of notices) {
      const date = (n.created_at || today).toString().split('T')[0].split(' ')[0]
      xml += `  <url>
    <loc>${SITE}/notice#notice-${n.id}</loc>
    <lastmod>${date}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>\n`
    }

    xml += `</urlset>`

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      }
    })
  } catch (e: any) {
    // Fallback: 정적 sitemap 서빙은 serveStatic이 처리
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
function escHtml(str: string): string {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}
// HTML 태그 제거 (plain text 추출)
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}
// 날짜 포맷 (YYYY-MM-DD)
function fmtDate(d: string | null): string {
  if (!d) return new Date().toISOString().split('T')[0]
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
<link href="/pages.css" rel="stylesheet">`

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
    const page = parseInt(c.req.query('page') || '1')
    const size = 20
    const offset = (page - 1) * size

    const countRow: any = await db.prepare(`SELECT COUNT(*) as cnt FROM blog_posts WHERE is_published = 1`).first()
    const total = countRow?.cnt || 0
    const totalPages = Math.ceil(total / size)

    const result = await db.prepare(
      `SELECT b.id, b.title, b.content, b.category, b.thumbnail_url, b.created_at,
              d.name as doctor_name, d.photo_url as doctor_photo
       FROM blog_posts b LEFT JOIN doctors d ON b.doctor_id = d.id
       WHERE b.is_published = 1 ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
    ).bind(size, offset).all()
    const posts = result.results || []

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
      if (page > 1) links.push(`<a href="/blog?page=${page - 1}" style="color:var(--gold)">← 이전</a>`)
      for (let i = 1; i <= totalPages; i++) {
        if (i === page) links.push(`<span style="color:var(--gold);font-weight:bold">${i}</span>`)
        else links.push(`<a href="/blog?page=${i}" style="color:var(--stone-l)">${i}</a>`)
      }
      if (page < totalPages) links.push(`<a href="/blog?page=${page + 1}" style="color:var(--gold)">다음 →</a>`)
      pagination = `<nav aria-label="블로그 페이지네이션" style="display:flex;gap:1rem;justify-content:center;margin-top:2rem;flex-wrap:wrap">${links.join('')}</nav>`
    }

    const jsonLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      "name": "서울가온치과 블로그",
      "description": "의정부 서울가온치과 블로그. 임플란트, 심미치료, 신경치료 등 치과 건강 정보를 쉽고 정직하게 전합니다.",
      "url": `${SITE}/blog${page > 1 ? `?page=${page}` : ''}`,
      "isPartOf": { "@type": "WebSite", "name": "서울가온치과", "url": SITE },
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
<title>블로그${page > 1 ? ` — ${page}페이지` : ''} | 서울가온치과</title>
<meta name="description" content="서울가온치과 블로그. 임플란트, 심미치료, 신경치료, 레진빌드업 등 치과 건강 정보와 치료 이야기. 의정부 탑석역 5분.">
<meta name="keywords" content="의정부 치과 블로그, 서울가온치과 블로그, 임플란트 정보, 치과 건강정보, 의정부 치과">
<link rel="canonical" href="${SITE}/blog${page > 1 ? `?page=${page}` : ''}">
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
  <p style="color:var(--stone-l);margin-bottom:2rem">치과 건강 정보와 치료 이야기를 쉽고 정직하게 전합니다. <strong>${total}개</strong>의 글</p>
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
      'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large',
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
    const size = 20
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

    const caseCards = cases.map((ba: any) => {
      const beforeImg = ba.intraoral_before_url ? `<img src="${ba.intraoral_before_url}" alt="치료 전 - ${escHtml(ba.title)}" loading="lazy" style="width:50%;height:160px;object-fit:cover">` : `<div style="width:50%;height:160px;background:#333;display:flex;align-items:center;justify-content:center"><span style="color:#666">Before</span></div>`
      const afterImg = ba.intraoral_after_url ? `<img src="${ba.intraoral_after_url}" alt="치료 후 - ${escHtml(ba.title)}" loading="lazy" style="width:50%;height:160px;object-fit:cover">` : `<div style="width:50%;height:160px;background:#333;display:flex;align-items:center;justify-content:center"><span style="color:#666">After</span></div>`
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
      "isPartOf": { "@type": "WebSite", "name": "서울가온치과", "url": SITE },
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
      'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large',
    })
  } catch (e: any) {
    console.error('[SSR BA List ERROR]', e.message)
    return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>비포&애프터 | 서울가온치과</title></head><body><p>잠시 후 다시 시도해주세요.</p></body></html>`, 500)
  }
})

// ── SSR 블로그 포스트 상세 ──
app.get('/blog/:id', async (c) => {
  try {
    const db = c.env.DB
    await initDB(db)
    const id = c.req.param('id')
    const post: any = await db.prepare(
      `SELECT b.*, d.name as doctor_name, d.photo_url as doctor_photo, d.title as doctor_title, d.role as doctor_role
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

    const plainText = stripHtml(post.content)
    const metaDesc = post.meta_description || (plainText.length > 155 ? plainText.substring(0, 155) + '...' : plainText)
    const pageTitle = `${post.title} | 서울가온치과 블로그`
    const canonicalUrl = `${SITE}/blog/${id}`
    const ogImage = post.thumbnail_url || `${SITE}/images/og-blog.jpg`
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
    const isHtmlContent = post.content.trim().startsWith('<')
    let articleContent = ''
    if (isHtmlContent) {
      articleContent = post.content
    } else {
      articleContent = post.content.split('\n').filter((l: string) => l.trim()).map((l: string) => `<p>${escHtml(l)}</p>`).join('\n')
      if (images.length) {
        const cls = images.length === 1 ? 'bp-images single' : 'bp-images'
        articleContent += `<div class="${cls}">${images.map((img: any) => `<img src="${escHtml(img.image_url)}" alt="${escHtml(img.filename || post.title)}" loading="lazy">`).join('')}</div>`
      }
    }

    // 날짜 포맷 (한국어)
    const dateObj = new Date(post.created_at)
    const koDate = `${dateObj.getFullYear()}년 ${dateObj.getMonth() + 1}월 ${dateObj.getDate()}일`

    // JSON-LD: BlogPosting + BreadcrumbList + MedicalOrganization
    const jsonLdBlog = {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      "headline": post.title,
      "description": metaDesc,
      "url": canonicalUrl,
      "image": ogImage,
      "datePublished": publishDate,
      "dateModified": modifiedDate,
      "author": { "@type": "Person", "name": authorName, "jobTitle": authorTitle, "worksFor": { "@type": "Dentist", "name": "서울가온치과의원" } },
      "publisher": {
        "@type": "Dentist",
        "name": "서울가온치과의원",
        "url": SITE,
        "logo": { "@type": "ImageObject", "url": `${SITE}/images/og-main.jpg` },
        "address": { "@type": "PostalAddress", "addressLocality": "의정부시", "addressRegion": "경기도", "streetAddress": "용민로 22, 4층", "postalCode": "11697", "addressCountry": "KR" },
        "telephone": "0507-1325-3377"
      },
      "mainEntityOfPage": { "@type": "WebPage", "@id": canonicalUrl },
      "inLanguage": "ko",
      "articleSection": post.category || "치과 건강정보",
      "wordCount": plainText.split(/\s+/).length,
      "keywords": `${post.category || '치과'}, 서울가온치과, 의정부 치과, ${post.title}`
    }

    const jsonLdBreadcrumb = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "홈", "item": SITE },
        { "@type": "ListItem", "position": 2, "name": "블로그", "item": `${SITE}/blog` },
        { "@type": "ListItem", "position": 3, "name": post.title, "item": canonicalUrl }
      ]
    }

    // Dentist Organization schema (사이트 전역)
    const jsonLdOrg = {
      "@context": "https://schema.org",
      "@type": "Dentist",
      "name": "서울가온치과의원",
      "url": SITE,
      "logo": `${SITE}/images/og-main.jpg`,
      "image": `${SITE}/images/og-main.jpg`,
      "description": "의정부 임플란트·심미치료·신경치료 전문 치과. 서울대학교 출신 의료진이 정직하고 바른 진료를 약속합니다.",
      "address": { "@type": "PostalAddress", "addressLocality": "의정부시", "addressRegion": "경기도", "streetAddress": "용민로 22, 4층(용현동)", "postalCode": "11697", "addressCountry": "KR" },
      "geo": { "@type": "GeoCoordinates", "latitude": "37.7381", "longitude": "127.0337" },
      "telephone": "0507-1325-3377",
      "openingHoursSpecification": [
        { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday","Tuesday","Wednesday","Friday"], "opens": "09:30", "closes": "18:30" },
        { "@type": "OpeningHoursSpecification", "dayOfWeek": "Thursday", "opens": "09:30", "closes": "20:30" },
        { "@type": "OpeningHoursSpecification", "dayOfWeek": "Saturday", "opens": "09:30", "closes": "14:00" }
      ],
      "priceRange": "$$",
      "areaServed": { "@type": "City", "name": "의정부시" },
      "medicalSpecialty": ["Dentistry", "Implantology", "Cosmetic Dentistry", "Endodontics"],
      "sameAs": ["https://pf.kakao.com/_LLxhwG"]
    }

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>${escHtml(pageTitle)}</title>
<meta name="description" content="${escHtml(metaDesc)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
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
<script type="application/ld+json">${JSON.stringify(jsonLdBlog)}</script>
<script type="application/ld+json">${JSON.stringify(jsonLdBreadcrumb)}</script>
<script type="application/ld+json">${JSON.stringify(jsonLdOrg)}</script>
<style>
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
  <article class="bp-content" itemprop="articleBody">${articleContent}</article>
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
      'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
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

    const pageTitle = `${item.title} | 서울가온치과 비포&애프터`
    const metaDesc = item.description
      ? (item.description.length > 155 ? item.description.substring(0, 155) + '...' : item.description)
      : `${item.title} - 서울가온치과 ${item.category || '치과'} 치료 전후 비교 사진. 의정부 임플란트·심미치료 전문.`
    const canonicalUrl = `${SITE}/before-after/${id}`
    const ogImage = item.intraoral_after_url || item.intraoral_before_url || `${SITE}/images/og-main.jpg`
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
      if (item.intraoral_before_url) imagesHtml += `<figure><img src="${escHtml(item.intraoral_before_url)}" alt="${escHtml(item.title)} 치료 전 구강 내 사진" loading="lazy" width="600" height="400"><figcaption>Before</figcaption></figure>`
      if (item.intraoral_after_url) imagesHtml += `<figure><img src="${escHtml(item.intraoral_after_url)}" alt="${escHtml(item.title)} 치료 후 구강 내 사진" loading="lazy" width="600" height="400"><figcaption>After</figcaption></figure>`
      imagesHtml += `</div></section>`
    }
    if (item.panorama_before_url || item.panorama_after_url) {
      imagesHtml += `<section class="ba-compare"><h2><i class="fas fa-x-ray"></i> 파노라마 사진</h2><div class="ba-pair">`
      if (item.panorama_before_url) imagesHtml += `<figure><img src="${escHtml(item.panorama_before_url)}" alt="${escHtml(item.title)} 치료 전 파노라마" loading="lazy" width="600" height="300"><figcaption>Before</figcaption></figure>`
      if (item.panorama_after_url) imagesHtml += `<figure><img src="${escHtml(item.panorama_after_url)}" alt="${escHtml(item.title)} 치료 후 파노라마" loading="lazy" width="600" height="300"><figcaption>After</figcaption></figure>`
      imagesHtml += `</div></section>`
    }

    // JSON-LD: MedicalProcedure + BreadcrumbList + Dentist
    const jsonLdProcedure: any = {
      "@context": "https://schema.org",
      "@type": "MedicalWebPage",
      "name": item.title,
      "description": metaDesc,
      "url": canonicalUrl,
      "image": ogImage,
      "datePublished": publishDate,
      "dateModified": modifiedDate,
      "author": { "@type": "Person", "name": authorName, "jobTitle": authorTitle },
      "publisher": { "@type": "Dentist", "name": "서울가온치과의원", "url": SITE },
      "mainEntity": {
        "@type": "MedicalProcedure",
        "name": `${item.category || '치과'} 치료`,
        "procedureType": "http://schema.org/TherapeuticProcedure",
        "bodyLocation": "Mouth",
        "status": "http://schema.org/EventCompleted",
        "performedBy": { "@type": "Dentist", "name": authorName }
      },
      "about": {
        "@type": "MedicalCondition",
        "name": item.category || "치과 질환",
        "associatedAnatomy": { "@type": "AnatomicalStructure", "name": "치아" }
      },
      "inLanguage": "ko",
      "keywords": `${item.category || '치과'}, 비포애프터, 치료전후, 서울가온치과, 의정부 치과`
    }

    // beforeAfter 이미지를 ImageGallery로 추가
    const galleryImages: any[] = []
    if (item.intraoral_before_url) galleryImages.push({ "@type": "ImageObject", "url": item.intraoral_before_url, "name": `${item.title} 치료 전 구강 내`, "description": "치료 전 구강 내 사진" })
    if (item.intraoral_after_url) galleryImages.push({ "@type": "ImageObject", "url": item.intraoral_after_url, "name": `${item.title} 치료 후 구강 내`, "description": "치료 후 구강 내 사진" })
    if (item.panorama_before_url) galleryImages.push({ "@type": "ImageObject", "url": item.panorama_before_url, "name": `${item.title} 치료 전 파노라마`, "description": "치료 전 파노라마 X-ray" })
    if (item.panorama_after_url) galleryImages.push({ "@type": "ImageObject", "url": item.panorama_after_url, "name": `${item.title} 치료 후 파노라마`, "description": "치료 후 파노라마 X-ray" })
    if (galleryImages.length) {
      jsonLdProcedure["image"] = galleryImages
    }

    const jsonLdBreadcrumb = {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "홈", "item": SITE },
        { "@type": "ListItem", "position": 2, "name": "비포 애프터", "item": `${SITE}/before-after` },
        { "@type": "ListItem", "position": 3, "name": item.title, "item": canonicalUrl }
      ]
    }

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
${HEAD_COMMON}
<title>${escHtml(pageTitle)}</title>
<meta name="description" content="${escHtml(metaDesc)}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
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
<script type="application/ld+json">${JSON.stringify(jsonLdProcedure)}</script>
<script type="application/ld+json">${JSON.stringify(jsonLdBreadcrumb)}</script>
<style>
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
  <h1 class="ba-detail-title">${escHtml(item.title)}</h1>
  ${drHtml}
  ${item.description ? `<p class="ba-desc">${escHtml(item.description)}</p>` : ''}
  ${imagesHtml}
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
      'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
    })
  } catch (e: any) {
    console.error('[SSR BA ERROR]', e.message)
    return c.html(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>오류 | 서울가온치과</title></head><body><p>잠시 후 다시 시도해주세요.</p></body></html>`, 500)
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
  // ── 1. 의정부 치과 (대표 키워드) ──
  {
    slug: 'uijeongbu-dental',
    title: '의정부 치과 추천 | 서울가온치과 — 서울대 출신 의료진, 탑석역 5분',
    metaDesc: '의정부 치과 찾으시나요? 서울가온치과는 서울대학교 치의학과 출신 의료진이 임플란트·심미치료·신경치료를 직접 진료합니다. 탑석역 1번출구 도보 5분. 과잉진료 없는 정직한 치과. ☎ 0507-1325-3377',
    h1: '의정부 치과 추천 — 서울가온치과',
    heroSub: '서울대학교 출신 의료진이 직접 진료하는 의정부 치과',
    keywords: '의정부 치과, 의정부 치과 추천, 의정부치과, 의정부 치과의원, 탑석역 치과, 용현동 치과, 의정부 좋은치과, 의정부역 치과, 민락동 치과, 가능동 치과',
    category: '종합진료',
    sections: [
      {
        heading: '왜 의정부에서 서울가온치과를 선택할까요?',
        content: `<p>서울가온치과는 <strong>서울대학교 치의학과</strong> 출신 의료진이 직접 진료하는 의정부 전문 치과입니다. '가온'은 대표원장의 딸 이름으로, <strong>"내 아이에게 하듯 정직하게"</strong>라는 진료 철학을 담고 있습니다.</p>
<p>의정부시 용민로에 위치하며 <strong>탑석역 1번출구에서 도보 5분</strong> 거리입니다. 임플란트, 심미치료(라미네이트·올세라믹), 신경치료, 레진빌드업, 일반진료까지 원스톱으로 진료합니다.</p>`
      },
      {
        heading: '서울가온치과의 핵심 진료 분야',
        content: `<ul>
<li><strong>가이드 임플란트</strong> — CT 기반 정밀 식립, 뼈이식·상악동거상술 가능, 만 65세 이상 건강보험 적용</li>
<li><strong>앞니 심미치료</strong> — 라미네이트, 올세라믹·지르코니아 크라운, 디지털 쉐이드 매칭</li>
<li><strong>신경치료</strong> — 서울대 보존과 전문의 조은비 원장 직접 시행, 미세현미경 활용</li>
<li><strong>레진빌드업</strong> — 크라운 없이 자연치아 최대 보존, 당일 완료 가능</li>
<li><strong>인비절라인 교정</strong> — 투명 교정장치로 심미적인 치아교정</li>
<li><strong>일반진료</strong> — 스케일링, 충치치료, 사랑니 발치 등</li>
</ul>`
      },
      {
        heading: '서울가온치과 의료진',
        content: `<p><strong>현진호 대표원장</strong> — 서울대학교 치의학과 졸업. 임플란트·보철 전문. CT 기반 가이드 수술로 정확성과 안전성을 확보합니다.</p>
<p><strong>조은비 원장</strong> — 서울대학교 치의학대학원 보존과 전문의. 신경치료·심미수복 전문. 미세현미경으로 정밀한 치료를 시행합니다.</p>`
      },
      {
        heading: '오시는 길 · 진료시간',
        content: `<p>📍 <strong>경기도 의정부시 용민로 22, 4층</strong> (용현동, 탑석역 1번출구 도보 5분)</p>
<p>🕐 <strong>진료시간</strong>: 월~금 10:00~19:00 / 토 10:00~15:00 / 일·공휴일 휴진</p>
<p>☎ <strong>전화예약</strong>: <a href="tel:0507-1325-3377">0507-1325-3377</a></p>
<p>💬 <strong>카카오톡 상담</strong>: <a href="https://pf.kakao.com/_LLxhwG/chat" target="_blank" rel="noopener">카카오톡으로 상담하기</a></p>`
      }
    ],
    faqs: [
      { q: '의정부 서울가온치과 위치가 어디인가요?', a: '경기도 의정부시 용민로 22, 4층(용현동)에 위치해 있습니다. 탑석역 1번출구에서 도보 5분 거리입니다.' },
      { q: '진료 예약은 어떻게 하나요?', a: '전화(0507-1325-3377) 또는 카카오톡 채널(서울가온치과)을 통해 예약 가능합니다.' },
      { q: '주차가 가능한가요?', a: '건물 지하 주차장 이용 가능합니다. 1시간 무료 주차를 제공합니다.' },
      { q: '의정부 서울가온치과 진료비는 어떻게 되나요?', a: '건강보험 적용 진료는 보험 수가로 진행되며, 비급여 항목은 진료 전 상세히 안내해 드립니다. 수가표는 홈페이지 안내 페이지에서 확인하실 수 있습니다.' },
    ],
    ctaText: '의정부 치과 상담 예약하기',
    relatedLinks: [
      { href: '/implant', label: '의정부 임플란트' },
      { href: '/aesthetic', label: '의정부 심미치료' },
      { href: '/resin-buildup', label: '의정부 레진빌드업' },
      { href: '/endodontics', label: '의정부 신경치료' },
      { href: '/invisalign', label: '의정부 인비절라인' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 2. 의정부 신경치료 ──
  {
    slug: 'endodontics',
    title: '의정부 신경치료 | 서울가온치과 — 서울대 보존과 전문의 직접 시행',
    metaDesc: '의정부 신경치료 전문 서울가온치과. 서울대학교 보존과 전문의 조은비 원장이 미세현미경으로 직접 시행합니다. 정확한 진단, 최소 삭제, 높은 성공률. 탑석역 5분. ☎ 0507-1325-3377',
    h1: '의정부 신경치료 전문 — 서울대 보존과 전문의',
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
      { href: '/implant', label: '의정부 임플란트' },
      { href: '/cavity-treatment', label: '의정부 충치치료' },
      { href: '/doctors', label: '의료진 소개' },
      { href: '/blog', label: '치과 건강 정보' },
    ]
  },
  // ── 3. 의정부 인비절라인 ──
  {
    slug: 'invisalign',
    title: '의정부 인비절라인 | 서울가온치과 — 투명교정 전문, 탑석역 5분',
    metaDesc: '의정부 인비절라인 투명교정 서울가온치과. 눈에 띄지 않는 투명 교정장치로 가지런한 치아를 만듭니다. 정밀 3D 시뮬레이션, 맞춤 치료 계획. 탑석역 5분. ☎ 0507-1325-3377',
    h1: '의정부 인비절라인 — 투명교정 전문',
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
      { href: '/glownate', label: '의정부 글로우네이트' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 4. 의정부 치아교정 ──
  {
    slug: 'orthodontics',
    title: '의정부 치아교정 | 서울가온치과 — 인비절라인·투명교정 전문',
    metaDesc: '의정부 치아교정 전문 서울가온치과. 인비절라인 투명교정, 부분교정, 심미교정까지. 3D 디지털 시뮬레이션으로 정확한 치료 계획. 탑석역 5분. ☎ 0507-1325-3377',
    h1: '의정부 치아교정 — 인비절라인·투명교정 전문',
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
      { href: '/glownate', label: '의정부 글로우네이트' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 5. 의정부 글로우네이트 ──
  {
    slug: 'glownate',
    title: '의정부 글로우네이트 | 서울가온치과 — 최소삭제 심미보철, 탑석역 5분',
    metaDesc: '의정부 글로우네이트 전문 서울가온치과. 치아 삭제를 최소화한 심미보철로 자연스럽고 아름다운 앞니를 완성합니다. 라미네이트보다 보존적, 치아 손상 최소. ☎ 0507-1325-3377',
    h1: '의정부 글로우네이트 — 최소삭제 심미보철',
    heroSub: '치아를 최소한으로 삭제하여 자연스럽고 아름다운 미소를 완성합니다',
    keywords: '의정부 글로우네이트, 글로우네이트, 글로우네이트 비용, 글로우네이트 후기, 의정부 라미네이트, 의정부 심미보철, 최소삭제 라미네이트, 의정부 앞니치료',
    category: '심미치료',
    sections: [
      {
        heading: '글로우네이트란 무엇인가요?',
        content: `<p>글로우네이트는 <strong>치아 삭제를 최소화</strong>한 심미보철 방법입니다. 기존 라미네이트가 치아 표면을 0.5~0.7mm 정도 삭제하는 데 비해, 글로우네이트는 <strong>0.1~0.3mm만 삭제</strong>하거나 경우에 따라 삭제 없이도 시술이 가능합니다.</p>
<p><strong>자연치아를 최대한 보존</strong>하면서도 색상, 형태, 배열을 아름답게 개선할 수 있어 최근 가장 주목받는 심미치료 방법입니다.</p>`
      },
      {
        heading: '글로우네이트 vs 라미네이트',
        content: `<ul>
<li><strong>삭제량</strong> — 글로우네이트: 0.1~0.3mm (최소) / 라미네이트: 0.5~0.7mm</li>
<li><strong>치아 보존</strong> — 글로우네이트가 자연치아를 더 많이 보존합니다</li>
<li><strong>시린 증상</strong> — 글로우네이트는 삭제량이 적어 시린 증상이 거의 없습니다</li>
<li><strong>강도</strong> — 최신 세라믹 소재로 충분한 강도를 확보합니다</li>
<li><strong>자연스러움</strong> — 초박형 세라믹으로 자연치아에 가장 가까운 투명감을 구현합니다</li>
</ul>`
      },
      {
        heading: '글로우네이트가 적합한 경우',
        content: `<ul>
<li>앞니 <strong>색상이 변한</strong> 경우 (테트라사이클린 변색 등)</li>
<li>앞니 <strong>형태가 마음에 들지 않는</strong> 경우</li>
<li>앞니 사이에 <strong>벌어진 공간</strong>이 있는 경우</li>
<li><strong>치아 삭제를 최소화</strong>하고 싶은 경우</li>
<li>이전에 레진 보수를 반복한 앞니를 <strong>깔끔하게 수복</strong>하고 싶은 경우</li>
</ul>`
      },
      {
        heading: '치료 과정',
        content: `<ol>
<li><strong>상담 · 진단</strong> — 현재 치아 상태 파악, 원하는 결과 상담</li>
<li><strong>디지털 디자인</strong> — 디지털 쉐이드 매칭으로 색상·형태 사전 설계</li>
<li><strong>최소 삭제 · 인상</strong> — 0.1~0.3mm 삭제 후 정밀 인상 채득</li>
<li><strong>전문 기공소 제작</strong> — 1:1 맞춤 초박형 세라믹 제작</li>
<li><strong>접착 · 완성</strong> — 특수 접착제로 견고하게 부착, 즉시 자연스러운 미소 완성</li>
</ol>`
      }
    ],
    faqs: [
      { q: '글로우네이트 비용은 얼마인가요?', a: '치아 수와 상태에 따라 달라지며, 상담 후 정확한 비용을 안내해 드립니다. 분할 납부도 가능합니다.' },
      { q: '글로우네이트는 얼마나 유지되나요?', a: '적절한 관리 시 10년 이상 유지됩니다. 일반적인 치아 관리(양치, 정기 검진)를 잘 해주시면 오래 사용하실 수 있습니다.' },
      { q: '글로우네이트 시술은 아프나요?', a: '삭제량이 매우 적어 마취 없이도 가능한 경우가 많으며, 시술 후 시린 증상도 거의 없습니다.' },
      { q: '글로우네이트와 라미네이트 중 어떤 것이 좋나요?', a: '치아 상태에 따라 다릅니다. 서울가온치과에서는 환자의 치아 상태를 정확히 진단한 후 가장 적합한 방법을 추천드립니다.' },
    ],
    ctaText: '글로우네이트 상담 예약',
    relatedLinks: [
      { href: '/aesthetic', label: '의정부 심미치료' },
      { href: '/invisalign', label: '의정부 인비절라인' },
      { href: '/before-after', label: '비포 애프터' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
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
    metaDesc: '의정부 임플란트 잘하는곳 찾으시나요? 서울가온치과는 CT 기반 가이드 임플란트로 정확하게, 최소 절개로 수술합니다. 서울대 출신 현진호 대표원장 직접 수술. 뼈이식·상악동거상술·전체임플란트 전문. ☎ 0507-1325-3377',
    h1: '의정부 임플란트 잘하는곳 — 서울가온치과',
    heroSub: 'CT 가이드 수술로 정확하고 안전한 임플란트, 서울대 출신 대표원장 직접 수술',
    keywords: '의정부 임플란트 잘하는곳, 의정부 임플란트, 의정부 임플란트 추천, 의정부 임플란트 비용, 의정부 임플란트 가격, 탑석역 임플란트, 의정부 치과 임플란트, 의정부 임플란트 후기',
    category: '임플란트',
    sections: [
      {
        heading: '서울가온치과 임플란트, 왜 다를까요?',
        content: `<p>서울가온치과는 모든 임플란트 수술에 <strong>CT 기반 가이드 시스템</strong>을 적용합니다. 3D CT 촬영으로 잇몸뼈 상태를 정밀 분석한 뒤, 컴퓨터로 설계한 최적의 위치에 임플란트를 식립합니다.</p>
<p><strong>현진호 대표원장</strong>(서울대학교 치의학과 졸업)이 상담부터 수술, 보철까지 전 과정을 직접 책임집니다. 경기 북부 지역에서 <strong>전체임플란트, 뼈이식, 상악동거상술</strong>까지 원스톱으로 진행할 수 있는 전문 치과입니다.</p>`
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
      { href: '/full-mouth-implant', label: '전체 임플란트' },
      { href: '/bone-graft-implant', label: '뼈이식 임플란트' },
      { href: '/before-after', label: '임플란트 전후 사례' },
      { href: '/doctors', label: '의료진 소개' },
    ]
  },
  // ── 8. 의정부 전체 임플란트 ──
  {
    slug: 'full-mouth-implant',
    title: '의정부 전체임플란트 | 서울가온치과 — 위아래 전악 임플란트 전문',
    metaDesc: '의정부 전체임플란트(전악임플란트) 전문 서울가온치과. 틀니에서 임플란트로, 위아래 전체 임플란트까지. CT 가이드 수술로 정확한 식립. 현진호 대표원장 직접 수술. 82건+ 전체임플란트 실적. ☎ 0507-1325-3377',
    h1: '의정부 전체임플란트 전문 — 서울가온치과',
    heroSub: '틀니에서 임플란트로, 위아래 전악 임플란트까지 원스톱 치료',
    keywords: '의정부 전체임플란트, 의정부 전악임플란트, 의정부 전체 임플란트 비용, 의정부 틀니 임플란트, 전체 임플란트 잘하는곳, 의정부 위아래 임플란트, 탑석역 전체임플란트',
    category: '전체임플란트',
    sections: [
      {
        heading: '서울가온치과 전체임플란트 전문성',
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
    title: '의정부 앞니임플란트 | 서울가온치과 — 심미적 앞니 복원 전문',
    metaDesc: '의정부 앞니임플란트 전문 서울가온치과. 앞니는 심미성이 특히 중요합니다. CT 가이드 수술로 정확한 위치에 식립, PFZ 보철로 자연스러운 앞니를 완성합니다. 현진호 대표원장 직접 수술. ☎ 0507-1325-3377',
    h1: '의정부 앞니임플란트 — 자연스러운 심미 복원',
    heroSub: '앞니는 얼굴의 인상을 결정합니다. CT 가이드 + PFZ 보철로 자연스럽게',
    keywords: '의정부 앞니 임플란트, 의정부 앞니 치료, 앞니 임플란트 비용, 앞니 임플란트 후기, 의정부 앞니 보철, 앞니 깨짐, 앞니 부러짐, 앞니 크라운',
    category: '앞니임플란트',
    sections: [
      {
        heading: '앞니 임플란트, 왜 전문성이 중요한가요?',
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
    title: '의정부 뼈이식 임플란트 | 서울가온치과 — 상악동거상술·뼈이식 전문',
    metaDesc: '의정부 뼈이식 임플란트 전문 서울가온치과. 잇몸뼈가 부족해 다른 치과에서 안 된다고 하셨나요? 상악동거상술·수직골증강까지. 현진호 대표원장(서울대) 직접 수술. ☎ 0507-1325-3377',
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
    metaDesc: '의정부 라미네이트 전문 서울가온치과. 앞니 변색·벌어짐·왜소치를 최소삭제 라미네이트로 자연스럽게 개선합니다. 디지털 쉐이드 매칭. 글로우네이트 시술 가능. ☎ 0507-1325-3377',
    h1: '의정부 라미네이트 — 최소삭제로 자연스러운 앞니',
    heroSub: '변색·벌어짐·왜소치, 라미네이트로 자연스럽게 개선합니다',
    keywords: '의정부 라미네이트, 의정부 라미네이트 비용, 의정부 앞니 라미네이트, 라미네이트 가격, 의정부 심미치료, 탑석역 라미네이트, 의정부 치아성형',
    category: '라미네이트',
    sections: [
      {
        heading: '라미네이트란?',
        content: `<p>라미네이트는 앞니 표면을 <strong>최소한으로 삭제</strong>한 뒤, 얇은 도자기(세라믹) 쉘을 부착하여 <strong>치아의 형태·색상·크기</strong>를 개선하는 심미치료입니다. 네일아트처럼 얇은 보철물을 붙인다고 생각하시면 됩니다.</p>
<p>서울가온치과에서는 기존 라미네이트보다 치아 삭제를 더욱 줄인 <strong>글로우네이트(Glownate)</strong> 시술도 가능합니다.</p>`
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
        heading: '라미네이트 vs 올세라믹 크라운 vs 글로우네이트',
        content: `<table style="width:100%;border-collapse:collapse;margin:1em 0">
<tr style="background:var(--gold);color:#fff"><th style="padding:8px;border:1px solid #ddd">구분</th><th style="padding:8px;border:1px solid #ddd">치아삭제량</th><th style="padding:8px;border:1px solid #ddd">적합한 경우</th></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>라미네이트</strong></td><td style="padding:8px;border:1px solid #ddd">앞면 최소 삭제</td><td style="padding:8px;border:1px solid #ddd">변색, 형태개선</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>글로우네이트</strong></td><td style="padding:8px;border:1px solid #ddd">거의 무삭제</td><td style="padding:8px;border:1px solid #ddd">왜소치, 경미한 벌어짐</td></tr>
<tr><td style="padding:8px;border:1px solid #ddd"><strong>올세라믹 크라운</strong></td><td style="padding:8px;border:1px solid #ddd">전체 삭제</td><td style="padding:8px;border:1px solid #ddd">심한 손상, 신경치료 후</td></tr>
</table>`
      }
    ],
    faqs: [
      { q: '라미네이트 수명은 얼마나 되나요?', a: '일반적으로 10~15년 이상 사용 가능합니다. 딱딱한 음식을 직접 씹는 습관을 피하면 더 오래 유지됩니다.' },
      { q: '라미네이트 시술 후 아프나요?', a: '치아 삭제량이 적어 시술 후 시림이나 통증은 거의 없습니다. 일상생활에 바로 복귀 가능합니다.' },
      { q: '라미네이트와 글로우네이트 차이가 뭔가요?', a: '글로우네이트는 치아 삭제를 거의 하지 않는 방식입니다. 치아 상태에 따라 적합한 방법을 안내드립니다.' },
    ],
    ctaText: '라미네이트 상담 예약',
    relatedLinks: [
      { href: '/aesthetic', label: '앞니 심미치료' },
      { href: '/glownate', label: '글로우네이트' },
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
<p>📍 <strong>탑석역 도보 5분</strong> — 대중교통으로도 접근이 편리합니다.<br>🅿️ <strong>건물 내 무료주차</strong> — 차로 오셔도 주차 걱정 없습니다.</p>`
      },
      {
        heading: '목요일 야간에도 모든 진료 가능',
        content: `<p>일부 치과에서는 야간 시간에 <strong>간단한 진료만</strong> 가능한 경우가 있습니다. 서울가온치과는 목요일 야간에도 아래 <strong>모든 진료</strong>를 동일하게 제공합니다:</p>
<ul>
<li>🦷 <strong>임플란트</strong> — 상담, CT 촬영, 수술 모두 가능</li>
<li>😁 <strong>교정</strong> — 인비절라인·세라믹 교정 상담 및 조정</li>
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
<li><strong>편안한 진료 환경</strong> — 독립 수술실, 환자 모니터링 시스템</li>
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
    metaDesc: '의정부 응급치과 서울가온치과. 갑작스러운 치통, 보철물 탈락, 치아 외상 즉시 대응. 평일 저녁 7시·토요일 3시까지 진료. 당일 진료 가능. 의정부역 도보 5분. ☎ 0507-1325-3377',
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
  // ── 19. 탑석역 치과 ──
  {
    slug: 'tapseok-dental',
    title: '탑석역 치과 | 서울가온치과 — 탑석역 근처 믿을 수 있는 치과',
    metaDesc: '탑석역 치과 서울가온치과. 의정부역에서 1정거장, 탑석역에서 가까운 종합 치과. 임플란트·교정·심미·일반진료 전 과목. 400평 규모 최첨단 시설. 현진호 대표원장. ☎ 0507-1325-3377',
    h1: '탑석역 치과 — 서울가온치과에서 가까이 만나세요',
    heroSub: '탑석역에서 한 정거장. 규모와 실력을 갖춘 종합 치과를 만나보세요',
    keywords: '탑석역 치과, 탑석 치과, 탑석역 임플란트, 탑석역 교정, 탑석 근처 치과, 의정부 탑석 치과, 탑석역 치과 추천',
    category: '탑석역 치과',
    sections: [
      {
        heading: '탑석역에서 서울가온치과 오시는 길',
        content: `<p>서울가온치과는 <strong>의정부역 도보 5분</strong> 거리에 있어, 탑석역에서도 매우 가깝습니다.</p>
<ul>
<li>🚇 <strong>지하철</strong> — 1호선 탑석역 → 의정부역 (1정거장, 2분) → 도보 5분</li>
<li>🚌 <strong>버스</strong> — 탑석역 앞 정류장에서 의정부역 방면 다수 노선 이용 (약 5분)</li>
<li>🚗 <strong>차량</strong> — 탑석역에서 약 5분 거리 / 건물 내 무료주차</li>
</ul>
<p>📍 주소: <strong>경기도 의정부시 용민로 22, 4층(용현동)</strong></p>`
      },
      {
        heading: '왜 탑석 주민들이 서울가온치과를 선택할까요?',
        content: `<p>탑석·민락·장암 지역 주민분들이 서울가온치과를 찾는 이유:</p>
<ul>
<li><strong>400평 규모 종합 시설</strong> — 대학병원급 장비와 독립 수술실 6개</li>
<li><strong>전 진료과목 원스톱</strong> — 임플란트, 교정, 심미, 일반 진료 모두 한 곳에서</li>
<li><strong>현진호 대표원장 직접 진료</strong> — 임플란트 전문, 서울대 출신</li>
<li><strong>평일 저녁 7시까지</strong> — 퇴근 후에도 편하게 내원</li>
<li><strong>철저한 감염관리</strong> — 에어샤워, 개별 수술실, 1회용 소독 키트</li>
</ul>`
      },
      {
        heading: '서울가온치과 주요 진료과목',
        content: `<ul>
<li>🦷 <strong>임플란트</strong> — 단일·전체·뼈이식·상악동거상술 / 건강보험 적용</li>
<li>😁 <strong>교정</strong> — 인비절라인·세라믹 교정·부분교정</li>
<li>✨ <strong>심미치료</strong> — 라미네이트·레진빌드업·미백</li>
<li>🪥 <strong>일반 진료</strong> — 충치·신경치료·발치·스케일링</li>
<li>🦴 <strong>사랑니</strong> — 매복사랑니 전문 발치</li>
<li>💪 <strong>잇몸치료</strong> — 치주치료·잇몸수술</li>
</ul>
<p>탑석역에서 조금만 오시면, <strong>대학병원 수준의 진료</strong>를 동네 치과의 편안함으로 받으실 수 있습니다.</p>`
      }
    ],
    faqs: [
      { q: '탑석역에서 서울가온치과까지 얼마나 걸리나요?', a: '지하철로 1정거장(2분) + 도보 5분, 총 약 10분 이내입니다. 차량으로는 약 5분이며 건물 내 무료주차가 가능합니다.' },
      { q: '탑석 근처에서 임플란트 잘하는 치과를 찾고 있어요', a: '서울가온치과는 현진호 대표원장이 모든 임플란트 수술을 직접 진행하며, 독립 수술실 6개와 CT 등 대학병원급 장비를 갖추고 있습니다.' },
      { q: '주차가 가능한가요?', a: '네, 건물 내 무료주차가 가능합니다. 차량으로 편하게 오실 수 있습니다.' },
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
]

// ── SSR 랜딩페이지 렌더러 ──
function renderLandingPage(page: LandingPageData): string {
  const canonicalUrl = `${SITE}/${page.slug}`

  // JSON-LD: MedicalWebPage
  const jsonLdPage = {
    "@context": "https://schema.org",
    "@type": "MedicalWebPage",
    "name": page.h1,
    "description": page.metaDesc,
    "url": canonicalUrl,
    "inLanguage": "ko",
    "isPartOf": { "@type": "WebSite", "name": "서울가온치과", "url": SITE },
    "about": { "@type": "MedicalSpecialty", "name": page.category },
    "dateModified": new Date().toISOString().split('T')[0],
    "publisher": {
      "@type": "Dentist",
      "name": "서울가온치과의원",
      "url": SITE,
      "logo": `${SITE}/images/og-main.jpg`,
      "address": { "@type": "PostalAddress", "addressLocality": "의정부시", "addressRegion": "경기도", "streetAddress": "용민로 22, 4층(용현동)", "postalCode": "11697", "addressCountry": "KR" },
      "geo": { "@type": "GeoCoordinates", "latitude": "37.7381", "longitude": "127.0337" },
      "telephone": "0507-1325-3377",
      "openingHoursSpecification": [
        { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday","Tuesday","Wednesday","Friday"], "opens": "09:30", "closes": "18:30" },
        { "@type": "OpeningHoursSpecification", "dayOfWeek": "Thursday", "opens": "09:30", "closes": "20:30" },
        { "@type": "OpeningHoursSpecification", "dayOfWeek": "Saturday", "opens": "09:30", "closes": "14:00" }
      ],
      "priceRange": "$$",
      "areaServed": [
        { "@type": "City", "name": "의정부시" },
        { "@type": "AdministrativeArea", "name": "경기도" }
      ],
      "medicalSpecialty": ["Dentistry","Implantology","Cosmetic Dentistry","Endodontics","Orthodontics"]
    },
    "speakable": {
      "@type": "SpeakableSpecification",
      "cssSelector": ["h1", ".landing-section h2", ".landing-section p"]
    }
  }

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

  // FAQ HTML (SEO + 사용자 경험)
  const faqHtml = page.faqs.map((f, i) => `
    <div class="faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
      <button class="faq-q" aria-expanded="false" onclick="this.parentElement.classList.toggle('open');this.setAttribute('aria-expanded',this.parentElement.classList.contains('open'))">
        <span itemprop="name">${escHtml(f.q)}</span>
        <i class="fas fa-chevron-down"></i>
      </button>
      <div class="faq-a" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
        <div itemprop="text"><p>${escHtml(f.a)}</p></div>
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
    'glownate': '/images/clinic-makeup.jpg',
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
<script type="application/ld+json">${JSON.stringify(jsonLdFaq)}</script>
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
    <div class="landing-faq" itemscope itemtype="https://schema.org/FAQPage">
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

// ── 각 랜딩페이지에 대해 라우트 등록 ──
for (const page of LANDING_PAGES) {
  app.get(`/${page.slug}`, (c) => {
    const html = renderLandingPage(page)
    return c.html(html, 200, {
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=43200',
      'X-Robots-Tag': 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1',
    })
  })
}

// ══════════════════════════════════════════════════
//  STATIC FILES (must be last)
// ══════════════════════════════════════════════════
app.use('/*', serveStatic())

export default app
