import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { configDefaults, defineConfig, type Plugin } from 'vitest/config';

/** Dev only: POST a PNG data URL to /__shot?name=x and it is saved as .shots/x.png (for checking work). */
function shots(): Plugin {
  return {
    name: 'dev-shots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        const name = (new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const data = Buffer.concat(chunks).toString().replace(/^data:image\/png;base64,/, '');
          mkdirSync('.shots', { recursive: true });
          writeFileSync(`.shots/${name}.png`, Buffer.from(data, 'base64'));
          res.end('ok');
        });
      });
    },
  };
}

/** A short hash of every source file the builder's output depends on, sorted by path: the key its cached bodies live under. */
function builderHash(): string {
  const files = ['src/builder', 'src/recipe', 'src/util']
    .flatMap((d) => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${e.parentPath}/${e.name}`.replaceAll('\\', '/')))
    .sort();
  const h = createHash('sha1');
  for (const f of files) h.update(`${f}\n${readFileSync(f, 'utf8').replaceAll('\r\n', '\n')}\n`);
  return h.digest('hex').slice(0, 12);
}

/** Defines `__BUILDER_HASH__`; in dev, a change to the builder's source restarts the server so cached bodies of the old code are never used. */
function builderHashDefine(): Plugin {
  let hash = '';
  return {
    name: 'builder-hash',
    config() {
      hash = builderHash();
      return { define: { __BUILDER_HASH__: JSON.stringify(hash) } };
    },
    configureServer(server) {
      if (process.env.VITEST) return;
      const check = (f: string) => {
        if (/\/src\/(builder|recipe|util)\//.test(f.replaceAll('\\', '/')) && builderHash() !== hash) void server.restart();
      };
      for (const ev of ['change', 'add', 'unlink'] as const) server.watcher.on(ev, check);
    },
  };
}

/**
 * Dev: the API restarted mid-stream (`--watch` after a server edit). Vite's proxy answers 502 only while no headers are
 * out and otherwise leaves the response open for good, so the TV's and the phones' event streams would never see the
 * restart (the TV kept a dead join code). Ending it lets them reconnect: the TV registers afresh, phones rejoin.
 */
export function endBrokenStream(res: unknown): void {
  const r = res as { req?: unknown; headersSent?: boolean; writableEnded?: boolean; end?: () => void };
  if (r && 'req' in r && r.headersSent && !r.writableEnded) r.end?.();
}

/** The fight-balance tests run many whole bouts: they run on their own (`npm run balance`), not with `npm test`. */
const BALANCE = 'tests/balance/**/*.test.ts';

export default defineConfig({
  plugins: [shots(), builderHashDefine()],
  server: {
    port: 5200, strictPort: true,
    // xfwd: the API sees who the proxy forwarded for (X-Forwarded-For), so only the TV on this PC may host the relay
    proxy: { '/api': { target: 'http://localhost:8797', changeOrigin: false, xfwd: true, configure: (proxy) => void proxy.on('error', (_e, _req, res) => endBrokenStream(res)) } },
  },
  worker: { format: 'es' },
  // Rapier's compat build carries its WebAssembly inline (about 4 MB): it gets a chunk of its own, cached apart from the
  // app's code, and the size warning sits above it
  build: {
    target: 'es2023', chunkSizeWarningLimit: 4500,
    rollupOptions: {
      // voice.html (the voice audition page) is for `npm run dev` only: the dev server serves it, the build leaves it out
      input: { tv: 'index.html', phone: 'phone.html' },
      output: { manualChunks: (id: string) => (id.includes('@dimforge/rapier3d-compat') ? 'rapier' : undefined) },
    },
  },
  test: {
    environment: 'node',
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: [...configDefaults.exclude, BALANCE] } },
      { extends: true, test: { name: 'balance', include: [BALANCE] } },
    ],
  },
});
