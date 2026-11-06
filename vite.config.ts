import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  // 엣지 HTML 캐시 키에 빌드 번호를 넣어 배포마다 캐시가 새로 시작되게 (src/index.tsx EDGE_BUILD)
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  plugins: [
    build(),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ]
})
