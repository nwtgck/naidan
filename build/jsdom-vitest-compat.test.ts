// @vitest-environment jsdom
import { resolveObjectURL } from 'node:buffer';
import { describe, expect, it } from 'vitest';

describe('jsdom Blob compatibility with the test runtime', () => {
  it('preserves attachment bytes and content type in object URLs', async () => {
    const bytes = new Uint8Array([0, 17, 127, 128, 255]);
    const attachment = new File([bytes], 'attachment.bin', { type: 'application/octet-stream' });
    const url = URL.createObjectURL(attachment);
    using _cleanup = {
      [Symbol.dispose]() {
        URL.revokeObjectURL(url);
      },
    };

    const resolved = resolveObjectURL(url);
    if (resolved === undefined) {
      throw new Error('Expected the attachment object URL to resolve');
    }
    expect(resolved.type).toBe(attachment.type);
    expect(resolved.size).toBe(bytes.length);
    expect(new Uint8Array(await resolved.arrayBuffer())).toEqual(bytes);
  });

  it('revokes object URLs without retaining attachment bytes', () => {
    const url = URL.createObjectURL(new Blob(['attachment']));
    expect(resolveObjectURL(url)).toBeDefined();
    URL.revokeObjectURL(url);
    expect(resolveObjectURL(url)).toBeUndefined();
  });

  it('preserves Blob bodies when constructing requests', async () => {
    const text = 'attachment \u65e5\u672c\u8a9e';
    const request = new Request('https://example.test/upload', {
      method: 'POST',
      body: new Blob([text], { type: 'text/plain' }),
    });

    expect(request.headers.get('content-type')).toBe('text/plain');
    expect(await request.text()).toBe(text);
  });
});
