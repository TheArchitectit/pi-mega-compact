/**
 * dashboard-client/vite.config.ts — Vite build config.
 *
 * PREVENT-PI-004: the dev server binds to localhost only. The production
 * build is a static bundle served by the existing Node HTTP server in
 * extensions/dashboard-server/server.ts. No external network calls.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// guardrails-allow PREVENT-PI-004: Vite dev server is loopback-only (dashboard UI tooling); production build is static files, no runtime network.
export default defineConfig({
  plugins: [react()],
  root: 'src',
  base: './',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Allow importing A1 contract types from the dashboard-server tree.
      '@contracts': fileURLToPath(new URL('../dashboard-server/api-contracts', import.meta.url)),
    },
  },
});
