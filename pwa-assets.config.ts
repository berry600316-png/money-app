import { defineConfig, minimal2023Preset as preset } from '@vite-pwa/assets-generator/config'

// `npm run icons` regenerates every PNG in public/ from public/logo.svg (full-bleed artwork).
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: {
    ...preset,
    transparent: { ...preset.transparent, padding: 0, favicons: [] },
    maskable: { ...preset.maskable, padding: 0, resizeOptions: { background: '#284E43' } },
    apple: { ...preset.apple, padding: 0, resizeOptions: { background: '#284E43' } },
  },
  images: ['public/logo.svg'],
})
