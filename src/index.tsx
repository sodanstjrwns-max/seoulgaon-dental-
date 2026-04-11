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
  if (path === '/' || path.match(/^\/(treatments|doctors|philosophy|guide|faq|blog|notice|encyclopedia|before-after|signup|community|reservation)$/)) {
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

// Serve image from R2
app.get('/api/images/*', async (c) => {
  try {
    const r2 = c.env.R2
    const key = c.req.path.replace('/api/images/', '')
    if (!key) return c.json({ error: 'key 필요' }, 400)

    const obj = await r2.get(key)
    if (!obj) return c.notFound()

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    if (obj.etag) headers.set('ETag', obj.etag)

    return new Response(obj.body, { headers })
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
//  HEALTH CHECK
// ══════════════════════════════════════════════════
app.get('/api/health', async (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.3.0' })
})

// ══════════════════════════════════════════════════
//  STATIC FILES (must be last)
// ══════════════════════════════════════════════════
app.use('/*', serveStatic())

export default app
