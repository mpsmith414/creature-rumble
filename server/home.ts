import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import { makeServer } from './main';
import { phoneHost } from './net';

// 8797 is the API's port in dev too, so `npm run dev` and `npm run home` are not run together (HOME_PORT is for trying it beside a running dev server)
const PORT = Number(process.env.HOME_PORT) || 8797;

/** Home mode: the built TV page, the phone page and their assets, served after the API routes so `/api/*` always wins. */
export function homeApp(app: Hono, distDir: string): Hono {
  return app.use('*', serveStatic({ root: distDir }));
}

// run directly (`npm run home`), not when a test imports homeApp
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, model, keyFound } = makeServer(process.env);
  serve({ fetch: homeApp(app, resolve('dist')).fetch, port: PORT, hostname: '0.0.0.0' }, () => {
    console.log(`the Rumble (open on the TV):   http://localhost:${PORT}/`);
    console.log(`phones join at:                http://${phoneHost(process.env)}:${PORT}/phone.html`);
    console.log(`designer: ${model}; ${keyFound ? 'key found' : 'no ANTHROPIC_API_KEY yet (the designer will say it is resting)'}`);
  });
}
