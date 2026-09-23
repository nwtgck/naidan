/** Stable wire protocol shared by the page and the service worker. */
export const NETWORK_UPDATE_PARAMETER = '__naidan_update';
export const PWA_PROTOCOL = 'naidan-pwa-v1';

export type PWARequest =
  | { protocol: typeof PWA_PROTOCOL; type: 'info' }
  | { protocol: typeof PWA_PROTOCOL; type: 'bind-page'; buildId: string }
  | { protocol: typeof PWA_PROTOCOL; type: 'complete-page'; buildId: string };

export type PWAReply = {
  protocol: typeof PWA_PROTOCOL;
  buildId: string;
  ok: boolean;
};

export function isPWAReply(value: unknown): value is PWAReply {
  return typeof value === 'object' && value !== null
    && 'protocol' in value && value.protocol === PWA_PROTOCOL
    && 'buildId' in value && typeof value.buildId === 'string'
    && 'ok' in value && typeof value.ok === 'boolean';
}

export function networkUpdateToken({ url }: { url: URL }): string | undefined {
  const value = url.searchParams.get(NETWORK_UPDATE_PARAMETER);
  return value && /^[a-zA-Z0-9-]{16,80}$/.test(value) ? value : undefined;
}

export function networkUpdateUrl({ href, token }: { href: string; token: string }): URL {
  const url = new URL(href);
  url.searchParams.set(NETWORK_UPDATE_PARAMETER, token);
  if (!networkUpdateToken({ url })) throw new Error('Invalid network update token.');
  return url;
}

export const TEST_ONLY = {
};
