// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createDownloadHeaders, createDownloadUrl, downloadPrepareSchema, normalizeDownloadFilename } from './protocol';

describe('download protocol', () => {
  it('keeps v2 tokens only in the fragment, preserving Request.url for the worker', () => {
    const base = new URL('https://example.test/nested/app/');
    const token = crypto.randomUUID();
    const url = createDownloadUrl({ base, token, version: 2 });
    expect(url.pathname).toBe('/nested/app/__naidan_download__/v2/');
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#?id=${token}`);
    expect(new Request(url).url).toBe(url.href);
    // This checks the URL layout, not an actual browser network request.
    url.hash = '';
    expect(url.href).not.toContain(token);
    expect(createDownloadUrl({ base, token, version: 1 }).href).toBe(`${base.href}__naidan_download__/v1/${token}`);
  });

  it('safely encodes Japanese names and quotes without allowing header injection', () => {
    const headers = createDownloadHeaders({ metadata: {
      filename: '日本語"' + String.fromCharCode(13, 10) + 'X-Evil: yes.zip',
    } });
    expect(headers.get('content-disposition')).toContain("filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E%22__X-Evil%3A%20yes.zip");
    expect(headers.has('x-evil')).toBe(false);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.has('content-length')).toBe(false);
  });
  it('permits attachment downloads without allowing scripts or same-origin sandbox privileges', () => {
    const headers = createDownloadHeaders({ metadata: { filename: 'download.bin' } });
    expect(headers.get('content-security-policy')).toBe("default-src 'none'; sandbox allow-downloads");
  });
  it('keeps navigation responses compatible with cross-origin isolated parents', () => {
    const headers = createDownloadHeaders({ metadata: { filename: 'isolated.bin' } });
    expect(headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });
  it('omits unknown sizes and preserves an explicit zero', () => {
    expect(createDownloadHeaders({ metadata: { filename: 'empty', size: 0 } }).get('content-length')).toBe('0');
  });
  it('handles paths, empty names and unpaired surrogate input', () => {
    expect(normalizeDownloadFilename({ filename: 'a/b\\c.zip' })).toBe('a_b_c.zip');
    expect(normalizeDownloadFilename({ filename: ' ' })).toBe('download');
    expect(() => createDownloadHeaders({ metadata: { filename: '\ud800' } })).not.toThrow();
  });
  it('rejects invalid versions, tokens and guessed or unsafe content lengths', () => {
    const request = { type: 'naidan-download/prepare', version: 1, token: crypto.randomUUID(), metadata: { filename: 'file' } };
    expect(downloadPrepareSchema.safeParse(request).success).toBe(true);
    expect(downloadPrepareSchema.safeParse({ ...request, version: 2 }).success).toBe(true);
    for (const value of [
      { ...request, version: 3 }, { ...request, token: '../file' },
      { ...request, metadata: { filename: 'x', size: -1 } },
      { ...request, metadata: { filename: 'x', size: Number.MAX_SAFE_INTEGER + 1 } },
    ]) expect(downloadPrepareSchema.safeParse(value).success).toBe(false);
  });
});
