import { describe, expect, it } from 'vitest';
import { endBrokenStream } from '../vite.config';

/** A proxied response as vite's proxy error handler sees it (an HTTP response carries its request; a WebSocket does not). */
const response = (headersSent: boolean, writableEnded = false) => {
  const r = { req: { url: '/api/relay/host/events?h=x' }, headersSent, writableEnded, ended: 0, end() { r.ended++; r.writableEnded = true; } };
  return r;
};

describe('the dev proxy after the API restarts mid-stream', () => {
  it('ends an event stream whose headers are already out, so the page sees it close and reconnects', () => {
    const r = response(true);
    endBrokenStream(r);
    expect(r.ended).toBe(1);
  });

  it('leaves a response with no headers yet to vite (it answers 502) and one already ended alone', () => {
    const early = response(false), done = response(true, true);
    endBrokenStream(early);
    endBrokenStream(done);
    expect(early.ended).toBe(0);
    expect(done.ended).toBe(0);
  });

  it('ignores a WebSocket (no request on it: vite closes those itself)', () => {
    let ended = 0;
    endBrokenStream({ headersSent: true, writableEnded: false, end: () => ended++ });
    expect(ended).toBe(0);
  });
});
