import { Buffer } from 'node:buffer';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { handleMockRequest } from './dev-mocks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const imaging = resolve(__dirname, '../imaging/src');

// Dev-only stub for `/api/v1/*` so the UI renders before the FastAPI
// backend (T183+) is reachable. Fixtures live in ./dev-mocks.ts.
// Set VITE_LIVERRA_MOCK_API=false to opt out once the real backend is up.
function liverraDevApiStub(disabled: boolean): Plugin {
  const send = (
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (b?: string) => void },
    status: number,
    body: unknown,
  ): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(body === null ? '' : JSON.stringify(body));
  };

  return {
    name: 'liverra-dev-api-stub',
    apply: 'serve',
    configureServer(server) {
      if (disabled) return;

      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/v1/')) return next();

        const [path, queryString = ''] = url.split('?');
        const method = (req.method ?? 'GET').toUpperCase();
        const query = new URLSearchParams(queryString);

        const result = handleMockRequest({ url, path, query, method });
        if (result) return send(res, result.status, result.body);

        return send(res, 404, { error: 'stubbed_endpoint_not_implemented', path, method });
      });
    },
  };
}

// Dev-only basic-auth credentials for the local Orthanc. The browser never
// sees them — the Vite proxy injects the header server-side on each forwarded
// request. Production uses nginx + Cognito JWT instead; the browser will send
// a Bearer token and the proxy entry here is a dev convenience only.
const ORTHANC_DEV_USER = process.env.ORTHANC_DEV_USER ?? 'orthanc';
const ORTHANC_DEV_PASSWORD = process.env.ORTHANC_DEV_PASSWORD ?? 'orthanc';
// Use 127.0.0.1 not `localhost` — on macOS the latter resolves to ::1 first
// but the default Orthanc container publishes IPv4 only, so `localhost` 500s.
const ORTHANC_DEV_ORIGIN = process.env.ORTHANC_DEV_ORIGIN ?? 'http://127.0.0.1:8042';

// Production safety: refuse to build if dev-bypass is enabled WITHOUT a
// matching staging-credentials gate. Pure DEV_BYPASS in prod = authless app
// on the public internet. DEV_BYPASS + STAGING_EMAIL + STAGING_PASSWORD =
// recognized "staging tier" — user must type the shared credentials to
// flip the localStorage flag that primes the mock user.
if (process.env.NODE_ENV === 'production' && process.env.VITE_LIVERRA_DEV_BYPASS === 'true') {
  const stagingGateConfigured =
    !!process.env.VITE_LIVERRA_STAGING_EMAIL && !!process.env.VITE_LIVERRA_STAGING_PASSWORD;
  if (!stagingGateConfigured) {
    throw new Error(
      'PRODUCTION SAFETY: VITE_LIVERRA_DEV_BYPASS=true is not allowed in NODE_ENV=production '
      + 'without VITE_LIVERRA_STAGING_EMAIL + VITE_LIVERRA_STAGING_PASSWORD also set. '
      + 'Either unset DEV_BYPASS or configure the staging credentials gate.',
    );
  }
}

export default defineConfig(({ mode }) => {
  // Vite does NOT auto-load .env files into process.env (only into the
  // client bundle's import.meta.env). loadEnv() makes the .env.local
  // value visible here so devs can opt out of the stub via .env.local
  // instead of having to remember to export VITE_LIVERRA_MOCK_API on
  // every `npx vite` command.
  const env = loadEnv(mode, __dirname, '');
  const stubDisabled =
    (env.VITE_LIVERRA_MOCK_API ?? process.env.VITE_LIVERRA_MOCK_API) === 'false';

  return {
  plugins: [liverraDevApiStub(stubDisabled), react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      // DICOMweb: /dicom-web/* → Orthanc /dicom-web/*. The browser-side
      // dicomwebClient ships relative URLs (default `/dicom-web`) so every
      // QIDO/WADO/STOW call lands here first. Basic auth for the local
      // Orthanc is set server-side so credentials never touch the client
      // bundle. See `deploy/local/docker-compose.yml` (env
      // `ORTHANC__REGISTERED_USERS`) for the matching creds.
      '/dicom-web': {
        target: ORTHANC_DEV_ORIGIN,
        changeOrigin: true,
        // STOW-RS bodies are multipart/related binary; keep defaults.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            const creds = Buffer.from(`${ORTHANC_DEV_USER}:${ORTHANC_DEV_PASSWORD}`).toString('base64');
            proxyReq.setHeader('authorization', `Basic ${creds}`);
          });
        },
      },
      // Real-backend mode: forward /api/v1/* to a FastAPI orchestrator.
      // Only used when VITE_LIVERRA_MOCK_API=false; otherwise the
      // liverraDevApiStub() middleware (above) intercepts these requests
      // first and serves dev-mocks.ts fixtures.
      //
      // For the hybrid setup where the orchestrator runs on the GPU box
      // and the laptop only hosts the UI, set LIVERRA_API_ORIGIN to the
      // tailnet URL (e.g. `http://100.124.94.29:8090`). Defaults to the
      // local FastAPI on 8090 for the all-in-one dev box case.
      '/api': {
        target: process.env.LIVERRA_API_ORIGIN ?? 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
    },
  },
  // TODO: when Cornerstone3D integration lands, configure
  // `build.rollupOptions.output.manualChunks` to split the imaging bundle
  // (@cornerstonejs/*, dcmjs, dicom-parser) from the app shell so the
  // initial route doesn't have to download ~5 MB of viewer code up front.
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  // Cornerstone's DICOM image loader spawns web workers via
  // `new Worker(new URL('./decodeImageFrameWorker.ts', import.meta.url),
  // { type: 'module' })`. Vite's dep-optimizer re-bundles the library
  // into `.vite/deps/`, which breaks that worker URL — the browser hits
  // `/node_modules/.vite/deps/decodeImageFrameWorker.js?worker_file&type=module`
  // with net::ERR_FAILED, no pixels ever decode, and `setStack` hangs
  // forever (canvas stays black even though frames arrive over the wire).
  //
  // Fix: exclude the loader so Vite serves its own `new Worker(new URL(...))`
  // patterns unmodified, but force-include the UMD Emscripten codec bundles
  // so esbuild converts them into proper ESM (they ship with
  // `module.exports = …` + no default export, which Vite's raw loader
  // chokes on). Worker `format: 'es'` matches the library's ESM worker
  // emit.
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    // The loader imports codec WASM factories via their `/decodewasmjs`
    // (or `/wasmjs`) subpath exports. These are UMD Emscripten blobs with
    // `module.exports = …` and no default ESM export, so Vite's raw loader
    // errors with "does not provide an export named 'default'". Listing the
    // exact subpaths forces esbuild to pre-bundle them into ESM.
    include: [
      '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs',
      '@cornerstonejs/codec-charls/decodewasmjs',
      '@cornerstonejs/codec-openjpeg/decodewasmjs',
      '@cornerstonejs/codec-openjph/wasmjs',
      'dicom-parser',
    ],
  },
  worker: {
    format: 'es',
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
  };
});
