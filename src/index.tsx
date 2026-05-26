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
  if (path === '/' || path.match(/^\/(treatments|doctors|philosophy|guide|faq|blog|notice|encyclopedia|before-after|signup|community|reservation|aesthetic|resin-buildup|implant|uijeongbu-dental|endodontics|invisalign|orthodontics|glownate|cavity-treatment)$/) || path.match(/^\/(blog|before-after)\/\d+$/)) {
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

    return c.json({ id: result.meta.last_row_id, message: '비포&애프터 케이스가 등록되었습니다' }, 201)
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
        { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"], "opens": "10:00", "closes": "19:00" },
        { "@type": "OpeningHoursSpecification", "dayOfWeek": "Saturday", "opens": "10:00", "closes": "15:00" }
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
        { "@type": "OpeningHoursSpecification", "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday"], "opens": "10:00", "closes": "19:00" },
        { "@type": "OpeningHoursSpecification", "dayOfWeek": "Saturday", "opens": "10:00", "closes": "15:00" }
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
<meta property="og:image" content="${SITE}/images/og-main.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="ko_KR">
<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(page.title)}">
<meta name="twitter:description" content="${escHtml(page.metaDesc)}">
<meta name="twitter:image" content="${SITE}/images/og-main.jpg">
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
