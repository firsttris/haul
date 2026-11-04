import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { redact } from '@tanstack/redact/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

// In dev, the Rust server runs on :8080 and Vite proxies the API to it.
export default defineConfig({
  plugins: [
    // messages/{de,en}.json → src/paraglide (typed message functions); the language comes from src/i18n.ts
    paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide', outputStructure: 'message-modules', strategy: ['baseLocale'] }),
    react(),
    // The code keeps importing from react; at build time this points those imports to TanStack
    // Redact, a smaller runtime with React 19's API (no concurrent rendering, see
    // https://github.com/TanStack/redact)
    redact(),
  ],
  server: {
    proxy: {
      '/api': { target: process.env.HAUL_API ?? 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
