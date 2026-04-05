import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-pages'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ══════════════════════════════════════
//  HELPER: Password hashing (Web Crypto)
// ══════════════════════════════════════
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password + 'gaon-salt-2024')
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Base64 helpers (UTF-8 safe)
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  bytes.forEach(b => binary += String.fromCharCode(b))
  return btoa(binary)
}
function fromBase64(b64: string): string {
  const binary = atob(b64)
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

// Simple JWT-like token (HMAC-SHA256)
async function createToken(payload: object): Promise<string> {
  const header = toBase64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = toBase64(JSON.stringify({ ...payload, exp: Date.now() + 86400000 }))
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode('gaon-secret-key-2024'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`))
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return `${header}.${body}.${signature}`
}

async function verifyToken(token: string): Promise<any> {
  try {
    const [header, body, signature] = token.split('.')
    const encoder = new TextEncoder()
    const key = await crypto.subtle.importKey('raw', encoder.encode('gaon-secret-key-2024'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const sigBuf = Uint8Array.from(atob(signature), c => c.charCodeAt(0))
    const valid = await crypto.subtle.verify('HMAC', key, sigBuf, encoder.encode(`${header}.${body}`))
    if (!valid) return null
    const payload = JSON.parse(fromBase64(body))
    if (payload.exp < Date.now()) return null
    return payload
  } catch { return null }
}

// Auth middleware
async function authMiddleware(c: any, next: any) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: '인증이 필요합니다' }, 401)
  const payload = await verifyToken(authHeader.slice(7))
  if (!payload) return c.json({ error: '토큰이 만료되었거나 유효하지 않습니다' }, 401)
  c.set('user', payload)
  await next()
}

// ══════════════════════════════════════
//  DB INIT (auto-create tables)
// ══════════════════════════════════════
let dbReady = false
async function initDB(db: D1Database) {
  if (dbReady) return
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT DEFAULT 'admin', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS blog_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, category TEXT DEFAULT '일반', is_published INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS blog_images (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, image_data TEXT NOT NULL, filename TEXT DEFAULT '', sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE)`,
    `CREATE TABLE IF NOT EXISTS before_after (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '', category TEXT DEFAULT '임플란트', intraoral_before TEXT, intraoral_after TEXT, panorama_before TEXT, panorama_after TEXT, is_published INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, is_pinned INTEGER DEFAULT 0, is_published INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
  ]
  for (const sql of tables) {
    await db.prepare(sql).run()
  }
  dbReady = true
}

// ══════════════════════════════════════
//  AUTH API
// ══════════════════════════════════════
app.post('/api/auth/register', async (c) => {
  const db = c.env.DB
  await initDB(db)
  const { email, password, name } = await c.req.json()
  if (!email || !password || !name) return c.json({ error: '모든 필드를 입력해주세요' }, 400)
  
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
  if (existing) return c.json({ error: '이미 등록된 이메일입니다' }, 409)
  
  const hash = await hashPassword(password)
  const result = await db.prepare('INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)').bind(email, hash, name).run()
  const token = await createToken({ id: result.meta.last_row_id, email, name, role: 'admin' })
  return c.json({ token, user: { id: result.meta.last_row_id, email, name } })
})

app.post('/api/auth/login', async (c) => {
  const db = c.env.DB
  await initDB(db)
  const { email, password } = await c.req.json()
  if (!email || !password) return c.json({ error: '이메일과 비밀번호를 입력해주세요' }, 400)
  
  const hash = await hashPassword(password)
  const user: any = await db.prepare('SELECT id, email, name, role FROM users WHERE email = ? AND password_hash = ?').bind(email, hash).first()
  if (!user) return c.json({ error: '이메일 또는 비밀번호가 올바르지 않습니다' }, 401)
  
  const token = await createToken({ id: user.id, email: user.email, name: user.name, role: user.role })
  return c.json({ token, user })
})

app.get('/api/auth/me', authMiddleware, async (c) => {
  return c.json({ user: c.get('user') })
})

// ══════════════════════════════════════
//  BLOG API
// ══════════════════════════════════════

// Public - list blogs
app.get('/api/blog', async (c) => {
  const db = c.env.DB
  await initDB(db)
  const posts = await db.prepare('SELECT id, title, content, category, created_at FROM blog_posts WHERE is_published = 1 ORDER BY created_at DESC').all()
  // Attach first image as thumbnail
  const result = []
  for (const post of posts.results || []) {
    const img: any = await db.prepare('SELECT image_data FROM blog_images WHERE post_id = ? ORDER BY sort_order LIMIT 1').bind(post.id).first()
    result.push({ ...post, thumbnail: img?.image_data || null })
  }
  return c.json({ posts: result })
})

// Public - single blog
app.get('/api/blog/:id', async (c) => {
  const db = c.env.DB
  await initDB(db)
  const id = c.req.param('id')
  const post = await db.prepare('SELECT * FROM blog_posts WHERE id = ? AND is_published = 1').bind(id).first()
  if (!post) return c.json({ error: '게시글을 찾을 수 없습니다' }, 404)
  const images = await db.prepare('SELECT id, image_data, filename, sort_order FROM blog_images WHERE post_id = ? ORDER BY sort_order').bind(id).all()
  return c.json({ post, images: images.results || [] })
})

// Admin - create blog
app.post('/api/admin/blog', authMiddleware, async (c) => {
  const db = c.env.DB
  const { title, content, category, images } = await c.req.json()
  if (!title || !content) return c.json({ error: '제목과 내용을 입력해주세요' }, 400)
  
  const result = await db.prepare('INSERT INTO blog_posts (title, content, category) VALUES (?, ?, ?)').bind(title, content, category || '일반').run()
  const postId = result.meta.last_row_id
  
  if (images && Array.isArray(images)) {
    for (let i = 0; i < images.length; i++) {
      await db.prepare('INSERT INTO blog_images (post_id, image_data, filename, sort_order) VALUES (?, ?, ?, ?)').bind(postId, images[i].data, images[i].name || '', i).run()
    }
  }
  return c.json({ id: postId, message: '블로그 게시글이 등록되었습니다' })
})

// Admin - list all blogs (including unpublished)
app.get('/api/admin/blog', authMiddleware, async (c) => {
  const db = c.env.DB
  const posts = await db.prepare('SELECT * FROM blog_posts ORDER BY created_at DESC').all()
  return c.json({ posts: posts.results || [] })
})

// Admin - delete blog
app.delete('/api/admin/blog/:id', authMiddleware, async (c) => {
  const db = c.env.DB
  const id = c.req.param('id')
  await db.prepare('DELETE FROM blog_images WHERE post_id = ?').bind(id).run()
  await db.prepare('DELETE FROM blog_posts WHERE id = ?').bind(id).run()
  return c.json({ message: '삭제되었습니다' })
})

// ══════════════════════════════════════
//  BEFORE & AFTER API
// ══════════════════════════════════════

// Public - list
app.get('/api/before-after', async (c) => {
  const db = c.env.DB
  await initDB(db)
  const cases = await db.prepare('SELECT * FROM before_after WHERE is_published = 1 ORDER BY created_at DESC').all()
  return c.json({ cases: cases.results || [] })
})

// Public - single
app.get('/api/before-after/:id', async (c) => {
  const db = c.env.DB
  await initDB(db)
  const item = await db.prepare('SELECT * FROM before_after WHERE id = ? AND is_published = 1').bind(c.req.param('id')).first()
  if (!item) return c.json({ error: '케이스를 찾을 수 없습니다' }, 404)
  return c.json({ case: item })
})

// Admin - create
app.post('/api/admin/before-after', authMiddleware, async (c) => {
  const db = c.env.DB
  const { title, description, category, intraoral_before, intraoral_after, panorama_before, panorama_after } = await c.req.json()
  if (!title) return c.json({ error: '제목을 입력해주세요' }, 400)
  
  const result = await db.prepare(`INSERT INTO before_after (title, description, category, intraoral_before, intraoral_after, panorama_before, panorama_after) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(title, description || '', category || '임플란트', intraoral_before || null, intraoral_after || null, panorama_before || null, panorama_after || null).run()
  return c.json({ id: result.meta.last_row_id, message: '비포&애프터 케이스가 등록되었습니다' })
})

// Admin - list all
app.get('/api/admin/before-after', authMiddleware, async (c) => {
  const db = c.env.DB
  const cases = await db.prepare('SELECT * FROM before_after ORDER BY created_at DESC').all()
  return c.json({ cases: cases.results || [] })
})

// Admin - delete
app.delete('/api/admin/before-after/:id', authMiddleware, async (c) => {
  const db = c.env.DB
  await db.prepare('DELETE FROM before_after WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ message: '삭제되었습니다' })
})

// ══════════════════════════════════════
//  NOTICES API
// ══════════════════════════════════════

// Public - list
app.get('/api/notices', async (c) => {
  const db = c.env.DB
  await initDB(db)
  const notices = await db.prepare('SELECT * FROM notices WHERE is_published = 1 ORDER BY is_pinned DESC, created_at DESC').all()
  return c.json({ notices: notices.results || [] })
})

// Admin - create
app.post('/api/admin/notices', authMiddleware, async (c) => {
  const db = c.env.DB
  const { title, content, is_pinned } = await c.req.json()
  if (!title || !content) return c.json({ error: '제목과 내용을 입력해주세요' }, 400)
  
  const result = await db.prepare('INSERT INTO notices (title, content, is_pinned) VALUES (?, ?, ?)').bind(title, content, is_pinned ? 1 : 0).run()
  return c.json({ id: result.meta.last_row_id, message: '공지사항이 등록되었습니다' })
})

// Admin - list all
app.get('/api/admin/notices', authMiddleware, async (c) => {
  const db = c.env.DB
  const notices = await db.prepare('SELECT * FROM notices ORDER BY created_at DESC').all()
  return c.json({ notices: notices.results || [] })
})

// Admin - delete
app.delete('/api/admin/notices/:id', authMiddleware, async (c) => {
  const db = c.env.DB
  await db.prepare('DELETE FROM notices WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ message: '삭제되었습니다' })
})

// ══════════════════════════════════════
//  STATIC FILES (must be last)
// ══════════════════════════════════════
app.use('/*', serveStatic())

export default app
