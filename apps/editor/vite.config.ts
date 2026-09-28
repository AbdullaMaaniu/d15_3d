import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE lets the GitHub Pages workflow serve the app from /<repo>/.
export default defineConfig({
  base: process.env.BASE ?? '/',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  server: { host: true },
});
