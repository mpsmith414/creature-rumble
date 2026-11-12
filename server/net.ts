import os from 'node:os';

const isPrivate = (a: string) => {
  const [p, q] = a.split('.').map(Number);
  return p === 10 || (p === 192 && q === 168) || (p === 172 && q >= 16 && q <= 31);
};

/** The first private IPv4 (192.168/16, 10/8, 172.16/12) of this machine, or `override`, or 'localhost'. */
export function lanHost(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, override?: string): string {
  if (override?.trim()) return override.trim();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) if ((i.family === 'IPv4' || (i.family as unknown) === 4) && !i.internal && isPrivate(i.address)) return i.address;
  }
  return 'localhost';
}

/** Where a phone opens the companion page: the join code rides in the link so the QR code is all a kid needs. */
export function phoneUrl(host: string, port: number, code: string): string {
  return `http://${host}:${port}/phone.html?c=${code}`;
}

/** The address phones should use: `PHONE_HOST` in `.env` (or the environment) overrides the detected LAN address. */
export function phoneHost(env: NodeJS.ProcessEnv, ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  return lanHost(ifaces, env.PHONE_HOST);
}

/** The PC itself: the TV page and Vite's dev proxy connect from one of these. */
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (address: string | undefined): boolean => !!address && LOOPBACK.has(address);

/**
 * Who really sent a request. `socket` is the connection's address. A loopback connection may be Vite's dev proxy
 * (`xfwd`), which appends the address it forwarded for to `X-Forwarded-For`: then that last entry counts (the earlier
 * ones are only the client's word). Anything else is taken as it is, its `X-Forwarded-For` ignored.
 */
export function requestAddress(socket: string | undefined, forwardedFor: string | undefined): string | undefined {
  if (!isLoopback(socket) || !forwardedFor?.trim()) return socket;
  return forwardedFor.split(',').at(-1)!.trim() || undefined;
}
