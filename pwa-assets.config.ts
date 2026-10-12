import { defineConfig, minimal2023Preset as preset } from '@vite-pwa/assets-generator/config'

// `npm run icons` regenerates every PNG in public/ from public/logo.png (the CJ artwork, full bleed; D-116).
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...preset,
    transparent: { ...preset.transparent, padding: 0, favicons: [] },
    maskable: { ...preset.maskable, padding: 0, resizeOptions: { background: '#0B3FA0' } },
    apple: { ...preset.apple, padding: 0, resizeOptions: { background: '#0B3FA0' } },
  },
  images: ['public/logo.png'],
})
