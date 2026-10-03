import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

// In dev, the Rust server runs on :8080 and Vite proxies the API to it.
export default defineConfig({
  plugins: [
    // messages/{de,en}.json → src/paraglide (typed message functions); the language comes from src/i18n.ts
    paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide', strategy: ['baseLocale'] }),
    react(),
  ],
  server: {
    proxy: {
      '/api': { target: process.env.HAUL_API ?? 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
