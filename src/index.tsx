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
    `CREATE TABLE IF NOT EXISTS blog_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT '일반',
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
    `CREATE INDEX IF NOT EXISTS idx_blog_published ON blog_posts(is_published, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_blog_category ON blog_posts(category)`,
    `CREATE INDEX IF NOT EXISTS idx_blog_images_post ON blog_images(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ba_published ON before_after(is_published, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_ba_category ON before_after(category)`,
    `CREATE INDEX IF NOT EXISTS idx_notices_published ON notices(is_published, is_pinned, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
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
//  AUTH API
// ══════════════════════════════════════════════════
app.post('/api/auth/register', async (c) => {
  try {
    const db = c.env.DB
    const body = await c.req.json<{ email: string; password: string; name: string }>()
    const { email, password, name } = body
    if (!email || !password || !name) return c.json({ error: '모든 필드를 입력해주세요' }, 400)
    if (password.length < 6) return c.json({ error: '비밀번호는 6자 이상이어야 합니다' }, 400)

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (existing) return c.json({ error: '이미 등록된 이메일입니다' }, 409)

    const hash = await hashPassword(password)
    const result = await db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').bind(email, hash, name).run()
    const userId = result.meta.last_row_id
    const token = await createToken({ id: userId, email, name, role: 'admin' })
    return c.json({ token, user: { id: userId, email, name, role: 'admin' } })
  } catch (e: any) {
    return c.json({ error: '회원가입 실패: ' + e.message }, 500)
  }
})

app.post('/api/auth/login', async (c) => {
  try {
    const db = c.env.DB
    const { email, password } = await c.req.json<{ email: string; password: string }>()
    if (!email || !password) return c.json({ error: '이메일과 비밀번호를 입력해주세요' }, 400)

    const hash = await hashPassword(password)
    const user: any = await db.prepare('SELECT id, email, name, role FROM users WHERE email = ? AND password_hash = ?').bind(email, hash).first()
    if (!user) return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' }, 401)

    const token = await createToken({ id: user.id, email: user.email, name: user.name, role: user.role })
    return c.json({ token, user })
  } catch (e: any) {
    return c.json({ error: '로그인 실패: ' + e.message }, 500)
  }
})

app.get('/api/auth/me', auth, async (c) => {
  return c.json({ user: c.get('user') })
})

// Change password
app.put('/api/auth/password', auth, async (c) => {
  try {
    const db = c.env.DB
    const user = c.get('user')
    const { current_password, new_password } = await c.req.json<{ current_password: string; new_password: string }>()
    if (!current_password || !new_password) return c.json({ error: '현재 비밀번호와 새 비밀번호를 입력해주세요' }, 400)
    if (new_password.length < 6) return c.json({ error: '새 비밀번호는 6자 이상이어야 합니다' }, 400)

    const currentHash = await hashPassword(current_password)
    const existing = await db.prepare('SELECT id FROM users WHERE id = ? AND password_hash = ?').bind(user.id, currentHash).first()
    if (!existing) return c.json({ error: '현재 비밀번호가 올바르지 않습니다' }, 401)

    const newHash = await hashPassword(new_password)
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(newHash, user.id).run()
    return c.json({ message: '비밀번호가 변경되었습니다' })
  } catch (e: any) {
    return c.json({ error: '비밀번호 변경 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  BLOG API — PUBLIC
// ══════════════════════════════════════════════════

// List published blogs (with pagination + search)
app.get('/api/blog', async (c) => {
  try {
    const db = c.env.DB
    const page = Math.max(1, parseInt(c.req.query('page') || '1'))
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
    const category = c.req.query('category')
    const search = c.req.query('search')
    const offset = (page - 1) * limit

    let whereParts = ['is_published = 1']
    const binds: any[] = []

    if (category) {
      whereParts.push('category = ?')
      binds.push(category)
    }
    if (search) {
      whereParts.push('(title LIKE ? OR content LIKE ?)')
      binds.push(`%${search}%`, `%${search}%`)
    }

    const where = whereParts.join(' AND ')
    const dataSql = `SELECT id, title, content, category, thumbnail_url, created_at FROM blog_posts WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as total FROM blog_posts WHERE ${where}`

    const dataBinds = [...binds, limit, offset]
    const posts = await runQuery(db, dataSql, dataBinds)
    const countResult: any = await runFirst(db, countSql, binds)
    const total = countResult?.total || 0

    return c.json({
      posts: posts.results || [],
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    })
  } catch (e: any) {
    return c.json({ error: '블로그 목록 조회 실패: ' + e.message }, 500)
  }
})

// Get single blog with images
app.get('/api/blog/:id', async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const post = await db.prepare('SELECT * FROM blog_posts WHERE id = ? AND is_published = 1').bind(id).first()
    if (!post) return c.json({ error: '게시글을 찾을 수 없습니다' }, 404)

    const images = await db.prepare('SELECT id, image_url, r2_key, filename, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all()
    return c.json({ post, images: images.results || [] })
  } catch (e: any) {
    return c.json({ error: '게시글 조회 실패: ' + e.message }, 500)
  }
})

// ══════════════════════════════════════════════════
//  BLOG API — ADMIN
// ══════════════════════════════════════════════════

// Create blog
app.post('/api/admin/blog', auth, async (c) => {
  try {
    const db = c.env.DB
    const { title, content, category, images } = await c.req.json<{
      title: string; content: string; category?: string;
      images?: { url: string; key: string; name: string }[]
    }>()
    if (!title?.trim()) return c.json({ error: '제목을 입력해주세요' }, 400)
    if (!content?.trim()) return c.json({ error: '내용을 입력해주세요' }, 400)

    const thumbnailUrl = images?.[0]?.url || null
    const result = await db.prepare(
      'INSERT INTO blog_posts (title, content, category, thumbnail_url) VALUES (?, ?, ?, ?)'
    ).bind(title.trim(), content.trim(), category || '일반', thumbnailUrl).run()
    const postId = result.meta.last_row_id

    if (images?.length) {
      for (let i = 0; i < images.length; i++) {
        await db.prepare(
          'INSERT INTO blog_images (post_id, image_url, r2_key, filename, sort_order) VALUES (?, ?, ?, ?, ?)'
        ).bind(postId, images[i].url, images[i].key, images[i].name || '', i).run()
      }
    }
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
    const { title, content, category, is_published, images } = await c.req.json<{
      title?: string; content?: string; category?: string; is_published?: number;
      images?: { url: string; key: string; name: string }[]
    }>()

    const existing = await db.prepare('SELECT id FROM blog_posts WHERE id = ?').bind(id).first()
    if (!existing) return c.json({ error: '게시글을 찾을 수 없습니다' }, 404)

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP']
    const vals: any[] = []
    if (title !== undefined) { sets.push('title = ?'); vals.push(title.trim()) }
    if (content !== undefined) { sets.push('content = ?'); vals.push(content.trim()) }
    if (category !== undefined) { sets.push('category = ?'); vals.push(category) }
    if (is_published !== undefined) { sets.push('is_published = ?'); vals.push(is_published) }

    if (images !== undefined) {
      const thumbUrl = images[0]?.url || null
      sets.push('thumbnail_url = ?')
      vals.push(thumbUrl)
    }

    vals.push(id)
    await db.prepare(`UPDATE blog_posts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()

    // Replace images if provided
    if (images !== undefined) {
      const oldImages = await db.prepare('SELECT r2_key FROM blog_images WHERE post_id = ?').bind(id).all()
      // Collect new keys to avoid deleting re-used images
      const newKeys = new Set(images.map(i => i.key))
      for (const img of (oldImages.results || []) as any[]) {
        if (img.r2_key && !newKeys.has(img.r2_key)) {
          await deleteR2Image(r2, img.r2_key)
        }
      }
      await db.prepare('DELETE FROM blog_images WHERE post_id = ?').bind(id).run()

      for (let i = 0; i < images.length; i++) {
        await db.prepare(
          'INSERT INTO blog_images (post_id, image_url, r2_key, filename, sort_order) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, images[i].url, images[i].key, images[i].name || '', i).run()
      }
    }

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
    const dataSql = `SELECT * FROM blog_posts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
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

// Get single blog (admin — includes unpublished)
app.get('/api/admin/blog/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const post = await db.prepare('SELECT * FROM blog_posts WHERE id = ?').bind(id).first()
    if (!post) return c.json({ error: '게시글을 찾을 수 없습니다' }, 404)

    const images = await db.prepare('SELECT id, image_url, r2_key, filename, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all()
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

    const images = await db.prepare('SELECT r2_key FROM blog_images WHERE post_id = ?').bind(id).all()
    for (const img of (images.results || []) as any[]) {
      await deleteR2Image(r2, img.r2_key)
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
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20')))
    const offset = (page - 1) * limit

    let whereParts = ['is_published = 1']
    const binds: any[] = []

    if (category) { whereParts.push('category = ?'); binds.push(category) }

    const where = whereParts.join(' AND ')
    const dataSql = `SELECT id, title, description, category,
      intraoral_before_url, intraoral_after_url, panorama_before_url, panorama_after_url,
      created_at FROM before_after WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    const countSql = `SELECT COUNT(*) as total FROM before_after WHERE ${where}`

    const cases = await runQuery(db, dataSql, [...binds, limit, offset])
    const countResult: any = await runFirst(db, countSql, binds)
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
      `SELECT id, title, description, category,
        intraoral_before_url, intraoral_after_url, panorama_before_url, panorama_after_url,
        created_at FROM before_after WHERE id = ? AND is_published = 1`
    ).bind(id).first()
    if (!item) return c.json({ error: '케이스를 찾을 수 없습니다' }, 404)
    return c.json({ case: item })
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
      title: string; description?: string; category?: string;
      intraoral_before?: { url: string; key: string };
      intraoral_after?: { url: string; key: string };
      panorama_before?: { url: string; key: string };
      panorama_after?: { url: string; key: string };
    }>()
    if (!body.title?.trim()) return c.json({ error: '제목을 입력해주세요' }, 400)

    const result = await db.prepare(`
      INSERT INTO before_after (title, description, category,
        intraoral_before_url, intraoral_before_key, intraoral_after_url, intraoral_after_key,
        panorama_before_url, panorama_before_key, panorama_after_url, panorama_after_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      body.title.trim(), body.description || '', body.category || '임플란트',
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
      title?: string; description?: string; category?: string; is_published?: number;
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
    const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50')))
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
    const item = await db.prepare('SELECT * FROM before_after WHERE id = ?').bind(id).first()
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
    const notice = await db.prepare('SELECT * FROM notices WHERE id = ? AND is_published = 1').bind(id).first()
    if (!notice) return c.json({ error: '공지사항을 찾을 수 없습니다' }, 404)
    return c.json({ notice })
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
    const { title, content, is_pinned } = await c.req.json<{ title: string; content: string; is_pinned?: boolean }>()
    if (!title?.trim()) return c.json({ error: '제목을 입력해주세요' }, 400)
    if (!content?.trim()) return c.json({ error: '내용을 입력해주세요' }, 400)

    const result = await db.prepare('INSERT INTO notices (title, content, is_pinned) VALUES (?, ?, ?)')
      .bind(title.trim(), content.trim(), is_pinned ? 1 : 0).run()
    return c.json({ id: result.meta.last_row_id, message: '공지사항이 등록되었습니다' }, 201)
  } catch (e: any) {
    return c.json({ error: '공지 등록 실패: ' + e.message }, 500)
  }
})

app.put('/api/admin/notices/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    const id = c.req.param('id')
    const { title, content, is_pinned, is_published } = await c.req.json<{
      title?: string; content?: string; is_pinned?: boolean; is_published?: number
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

app.delete('/api/admin/notices/:id', auth, async (c) => {
  try {
    const db = c.env.DB
    await db.prepare('DELETE FROM notices WHERE id = ?').bind(c.req.param('id')).run()
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
    const [blogs, cases, notices, users] = await Promise.all([
      db.prepare('SELECT COUNT(*) as count FROM blog_posts').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM before_after').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM notices').first() as Promise<any>,
      db.prepare('SELECT COUNT(*) as count FROM users').first() as Promise<any>,
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
//  HEALTH CHECK
// ══════════════════════════════════════════════════
app.get('/api/health', async (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' })
})

// ══════════════════════════════════════════════════
//  STATIC FILES (must be last)
// ══════════════════════════════════════════════════
app.use('/*', serveStatic())

export default app
