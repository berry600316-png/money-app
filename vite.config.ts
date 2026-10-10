/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

// GitHub Pages serves the app from https://<user>.github.io/money-app/
const PAGES_BASE = '/money-app/'

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? PAGES_BASE : '/',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      // We register manually (src/pwa/pwa.ts) so updates never reload mid-entry (D-43).
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        id: PAGES_BASE,
        name: 'Money',
        short_name: 'Money',
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
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
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
