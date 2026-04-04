import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-pages'

const app = new Hono()

// Serve all static files from public directory
app.use('/*', serveStatic())

export default app
