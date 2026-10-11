/// <reference types="vitest/config" />
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

// GitHub Pages serves the app from https://<user>.github.io/money-app/
const PAGES_BASE = '/money-app/'

/**
 * D-86: PDF.js needs its CJK character maps to read Chinese statements. Ship them with the app
 * (served in dev, emitted on build, precached by the service worker) — never fetched from a CDN.
 */
function pdfjsCMaps(): Plugin {
  const dir = resolve('node_modules/pdfjs-dist/cmaps')
  return {
    name: 'money-pdfjs-cmaps',
    configureServer(server) {
      server.middlewares.use('/pdfjs/cmaps', (req, res, next) => {
        const file = join(dir, decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, ''))
        if (!file.startsWith(dir) || !existsSync(file)) return next()
        res.setHeader('Content-Type', 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const f of readdirSync(dir)) this.emitFile({ type: 'asset', fileName: `pdfjs/cmaps/${f}`, source: readFileSync(join(dir, f)) })
    },
  }
}

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? PAGES_BASE : '/',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    pdfjsCMaps(),
    VitePWA({
      // We register manually (src/pwa/pwa.ts) so updates never reload mid-entry (D-43).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: PAGES_BASE,
        name: 'Cai Jie',
        short_name: 'Cai Jie',
        description: '只存在 iPhone 本機的個人記帳',
        lang: 'zh-Hant-TW',
        dir: 'ltr',
        start_url: PAGES_BASE,
        scope: PAGES_BASE,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#F7F6F2',
        theme_color: '#F7F6F2',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // mjs = PDF.js worker, bcmap = PDF.js character maps (D-86): both must work offline.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,webmanifest,bcmap}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { port: 5173 },
  preview: { port: 4173 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
}))
