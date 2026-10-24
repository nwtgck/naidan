import type { HttpEndpoint } from '@/01-models/types';

/** Normalize an explicitly entered API URL without authorizing any request. */
export function normalizeModelConnectionUrl({ input }: { input: string }): string | undefined {
  const value = input.trim();
  if (value.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/** Automatic discovery is limited to parsed loopback hosts, never substrings. */
export function isLoopbackModelConnectionUrl({ url }: { url: string }): boolean {
  const normalized = normalizeModelConnectionUrl({ input: url });
  if (normalized === undefined) {
    return false;
  }
  const hostname = new URL(normalized).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function modelConnectionApiKey({ headers }: { headers: readonly [string, string][] }): string {
  for (const [name, value] of headers) {
    if (name.trim().toLowerCase() === 'authorization') {
      const bearer = value.match(/^Bearer\s+(.+)$/i);
      if (bearer !== null) {
        return bearer[1] ?? '';
      }
    }
  }
  return '';
}

/** The API-key control edits the same header draft as the detailed editor. */
export function withModelConnectionApiKey({ headers, apiKey }: { headers: readonly [string, string][], apiKey: string }): [string, string][] {
  const token = apiKey.trim();
  const result: [string, string][] = [];
  for (const [name, value] of headers) {
    if (name.trim().toLowerCase() === 'authorization' && (token.length > 0 || /^Bearer(?:\s|$)/i.test(value))) {
      continue;
    }
    result.push([name, value]);
  }
  if (token.length > 0) {
    result.push(['Authorization', `Bearer ${token}`]);
  }
  return result;
}

export function modelConnectionHttpEndpoint({ type, url, headers }: { type: HttpEndpoint['type'], url: string, headers: readonly [string, string][] }): HttpEndpoint | undefined {
  const normalized = normalizeModelConnectionUrl({ input: url });
  if (normalized === undefined) {
    return undefined;
  }
  const httpHeaders: [string, string][] = headers.filter(([name]) => name.trim().length > 0).map(([name, value]) => [name.trim(), value]);
  return { type, url: normalized, httpHeaders: httpHeaders.length > 0 ? httpHeaders : undefined };
}

export const TEST_ONLY = {
};
