/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The manifest lives in public/manifest.webmanifest so it can be edited
      // by hand; the plugin only generates the service worker.
      manifest: false,
      includeAssets: ['favicon.svg', 'icons/*.png', 'brand/*.svg'],
      workbox: {
        // Cache only the built app shell. Supabase API / Realtime / Edge
        // Function traffic is never cached: attendance must always be
        // confirmed live by the server (no offline attendance queueing).
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,ttf}'],
        navigateFallback: '/index.html',
        // /templates/ holds downloadable import templates; never answer those
        // requests with the app shell.
        navigateFallbackDenylist: [/^\/api\//, /^\/templates\//],
        runtimeCaching: [],
      },
    }),
  ],
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
