// Vite config — to be populated by first implementation spec
// Expected plugins: @vitejs/plugin-react, vite-plugin-pwa, etc.
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
