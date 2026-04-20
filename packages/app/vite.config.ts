import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imaging = resolve(__dirname, '../imaging/src');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    alias: [
      // Subpath aliases MUST come before the bare-specifier alias.
      { find: '@liverra/imaging/watermark', replacement: resolve(imaging, 'watermark.ts') },
      { find: '@liverra/imaging/cornerstone', replacement: resolve(imaging, 'cornerstone/index.ts') },
      { find: '@liverra/imaging/voxel-count-worker', replacement: resolve(imaging, 'viewer/index.ts') },
      { find: '@liverra/imaging', replacement: resolve(imaging, 'index.ts') },
      { find: '@liverra/core', replacement: resolve(__dirname, '../core/src/index.ts') },
      { find: '@liverra/fhirtypes', replacement: resolve(__dirname, '../fhirtypes/src/index.ts') },
    ],
  },
});
