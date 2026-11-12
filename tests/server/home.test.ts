import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { homeApp } from '../../server/home';

describe('home-server mode', () => {
  let dir: string;
  let app: Hono;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'valley-dist-'));
    writeFileSync(join(dir, 'index.html'), '<p>the valley</p>');
    writeFileSync(join(dir, 'phone.html'), '<p>the phone</p>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'x.js'), 'console.log(1)');
    const api = new Hono();
    api.get('/api/health', (c) => c.json({ ok: true }));
    app = homeApp(api, dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('serves the valley at /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<p>the valley</p>');
  });

  it('serves the phone page and built assets', async () => {
    expect(await (await app.request('/phone.html')).text()).toBe('<p>the phone</p>');
    expect(await (await app.request('/assets/x.js')).text()).toBe('console.log(1)');
  });

  it('lets the API routes win over the files', async () => {
    const res = await app.request('/api/health');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('is a plain 404 for what is not there', async () => {
    expect((await app.request('/nope.html')).status).toBe(404);
  });
});
