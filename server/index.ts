import { serve } from '@hono/node-server';
import { makeServer } from './main';

const { app, model, workspaceId, keyFound } = makeServer(process.env);

serve({ fetch: app.fetch, port: 8797 }, () => {
  const key = keyFound ? 'key found' : 'no ANTHROPIC_API_KEY yet (the designer will say it is resting)';
  const ws = workspaceId ? `; workspace ${workspaceId}` : '';
  console.log(`creature designer on http://localhost:8797 using ${model}; ${key}${ws}`);
});
