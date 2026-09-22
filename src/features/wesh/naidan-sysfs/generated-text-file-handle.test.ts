// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promiseAllKeyed } from '@/utils/promise';
import { GeneratedTextFileHandle, TEST_ONLY } from './generated-text-file-handle';

afterEach(() => vi.restoreAllMocks());

describe('GeneratedTextFileHandle reads a single lazy text snapshot', () => {
  it('reports estimates without rendering and measures the actual size without fully encoding', async () => {
    const text = '日本語😀\ud800'.repeat(20_000);
    const expectedSize = new TextEncoder().encode(text).length;
    const render = vi.fn(async () => text);
    const handle = new GeneratedTextFileHandle({ estimatedSize: 4096, readText: render });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    expect((await handle.stat()).size).toBe(4096);
    expect(render).not.toHaveBeenCalled();
    const buffer = new Uint8Array(3);
    expect(await handle.read({ buffer })).toEqual({ bytesRead: 3 });
    expect(buffer).toEqual(new Uint8Array([230, 151, 165]));
    expect(encode).toHaveBeenCalledOnce();
    expect((await handle.stat()).size).toBe(expectedSize);
    expect(encode).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledOnce();
    await handle.close();
  });

  it('renders once for concurrent reads and advances only the implicit reads in continuation order', async () => {
    const pending = Promise.withResolvers<string>();
    const render = vi.fn(() => pending.promise);
    const handle = new GeneratedTextFileHandle({ estimatedSize: 1, readText: render });
    const first = new Uint8Array(2), positioned = new Uint8Array(2), second = new Uint8Array(2);
    const reading = promiseAllKeyed({
      first: handle.read({ buffer: first }),
      positioned: handle.read({ buffer: positioned, position: 4 }),
      second: handle.read({ buffer: second }),
    });
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect((await handle.stat()).size).toBe(1);
    pending.resolve('abcdef');
    expect(await reading).toEqual({ first: { bytesRead: 2 }, positioned: { bytesRead: 2 }, second: { bytesRead: 2 } });
    expect(new TextDecoder().decode(first)).toBe('ab');
    expect(new TextDecoder().decode(positioned)).toBe('ef');
    expect(new TextDecoder().decode(second)).toBe('cd');
    expect(await handle.read({ buffer: first })).toEqual({ bytesRead: 2 });
    expect(new TextDecoder().decode(first)).toBe('ef');
    await handle.close();
  });

  it('keeps one rendered snapshot even if the provider would subsequently return different text', async () => {
    const render = vi.fn().mockResolvedValueOnce('first').mockResolvedValue('changed');
    const handle = new GeneratedTextFileHandle({ estimatedSize: 0, readText: render });
    const buffer = new Uint8Array(5);
    await handle.read({ buffer });
    buffer.fill(0);
    await handle.read({ buffer, position: 0 });
    expect(new TextDecoder().decode(buffer)).toBe('first');
    expect(render).toHaveBeenCalledOnce();
    await handle.close();
  });

  it('supports byte positions inside UTF-8 characters and destination subviews', async () => {
    const text = '\uFEFF日😀\ud800x';
    const expected = new TextEncoder().encode(text);
    const handle = new GeneratedTextFileHandle({ estimatedSize: 0, readText: async () => text });
    const storage = new Uint8Array(12).fill(0xaa);
    const buffer = storage.subarray(2, 10);
    expect(await handle.read({ buffer, offset: 1, length: 3, position: 4 })).toEqual({ bytesRead: 3 });
    expect(storage.subarray(3, 6)).toEqual(expected.subarray(4, 7));
    expect(storage.subarray(0, 3).every(byte => byte === 0xaa)).toBe(true);
    expect(storage.subarray(6).every(byte => byte === 0xaa)).toBe(true);
    expect(await handle.read({ buffer, length: 2 })).toEqual({ bytesRead: 2 });
    expect(buffer.subarray(0, 2)).toEqual(expected.subarray(0, 2));
    await handle.close();
  });

  it('clamps requested length to destination capacity and returns bounded partial reads', async () => {
    const text = 'x'.repeat(TEST_ONLY.READ_CHUNK_SIZE + 3);
    const handle = new GeneratedTextFileHandle({ estimatedSize: 1, readText: async () => text });
    const small = new Uint8Array(2).fill(0xaa);
    expect(await handle.read({ buffer: small, offset: 1, length: 99 })).toEqual({ bytesRead: 1 });
    expect(small).toEqual(new Uint8Array([0xaa, 120]));
    const large = new Uint8Array(text.length).fill(0xaa);
    expect(await handle.read({ buffer: large })).toEqual({ bytesRead: TEST_ONLY.READ_CHUNK_SIZE });
    expect(large.subarray(TEST_ONLY.READ_CHUNK_SIZE).every(byte => byte === 0xaa)).toBe(true);
    expect(await handle.read({ buffer: large })).toEqual({ bytesRead: 2 });
    expect(await handle.read({ buffer: small })).toEqual({ bytesRead: 0 });
    await handle.close();
  });

  it('does not render for zero-capacity reads or encode when a seek is beyond EOF', async () => {
    const render = vi.fn(async () => 'hello');
    const handle = new GeneratedTextFileHandle({ estimatedSize: 17, readText: render });
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    expect(await handle.read({ buffer: new Uint8Array(0) })).toEqual({ bytesRead: 0 });
    expect(await handle.read({ buffer: new Uint8Array(4), length: 0 })).toEqual({ bytesRead: 0 });
    expect(await handle.read({ buffer: new Uint8Array(4), offset: 4, length: 99 })).toEqual({ bytesRead: 0 });
    expect(render).not.toHaveBeenCalled();
    expect(await handle.read({ buffer: new Uint8Array(1), position: Number.MAX_SAFE_INTEGER })).toEqual({ bytesRead: 0 });
    expect(render).toHaveBeenCalledOnce();
    expect(encode).not.toHaveBeenCalled();
    expect((await handle.stat()).size).toBe(5);
    const buffer = new Uint8Array(1);
    await handle.read({ buffer });
    expect(buffer[0]).toBe(104);
    await handle.close();
  });

  it('shares one failed attempt, preserves output and position, and allows a later explicit retry', async () => {
    const pending = Promise.withResolvers<string>();
    const error = new Error('Metadata read failed');
    const render = vi.fn(() => pending.promise);
    const handle = new GeneratedTextFileHandle({ estimatedSize: 9, readText: render });
    const buffers = Array.from({ length: 3 }, () => new Uint8Array(1).fill(0xaa));
    const attempts = buffers.map(buffer => handle.read({ buffer }));
    const rejected = Promise.all(attempts.map(attempt => expect(attempt).rejects.toBe(error)));
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    pending.reject(error);
    await rejected;
    expect(buffers.every(buffer => buffer[0] === 0xaa)).toBe(true);
    expect((await handle.stat()).size).toBe(9);
    render.mockResolvedValue('ok');
    const buffer = new Uint8Array(2);
    expect(await handle.read({ buffer })).toEqual({ bytesRead: 2 });
    expect(new TextDecoder().decode(buffer)).toBe('ok');
    expect(render).toHaveBeenCalledTimes(2);
    await handle.close();
  });

  it('propagates a synchronous renderer throw without poisoning future reads', async () => {
    const error = new Error('Synchronous failure');
    const render = vi.fn(async () => 'ok').mockImplementationOnce(() => {
      throw error;
    });
    const handle = new GeneratedTextFileHandle({ estimatedSize: 0, readText: render });
    await expect(handle.read({ buffer: new Uint8Array(1) })).rejects.toBe(error);
    expect(await handle.read({ buffer: new Uint8Array(1) })).toEqual({ bytesRead: 1 });
    await handle.close();
  });

  it.each([
    { offset: -1 }, { offset: 5 }, { offset: 0.5 }, { offset: NaN },
    { length: -1 }, { length: 0.5 }, { length: Infinity },
    { position: -1 }, { position: 1.5 }, { position: NaN }, { position: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid ranges without generating text: %j', async options => {
    const render = vi.fn(async () => 'input');
    const handle = new GeneratedTextFileHandle({ estimatedSize: 5, readText: render });
    const buffer = new Uint8Array(4).fill(0xaa);
    await expect(handle.read({ buffer, ...options })).rejects.toThrow(RangeError);
    expect(render).not.toHaveBeenCalled();
    expect(buffer.every(byte => byte === 0xaa)).toBe(true);
    await handle.close();
  });

  it('reads a large file without encoding any complete file-sized input', async () => {
    const text = '日😀\ud800x'.repeat(80_000);
    const expected = new TextEncoder().encode(text);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    const handle = new GeneratedTextFileHandle({ estimatedSize: 1, readText: async () => text });
    const output = new Uint8Array(expected.length);
    let position = 0;
    while (position < output.length) {
      const { bytesRead } = await handle.read({ buffer: output, offset: position });
      expect(bytesRead).toBeGreaterThan(0);
      position += bytesRead;
    }
    expect(await handle.read({ buffer: new Uint8Array(1) })).toEqual({ bytesRead: 0 });
    expect(output.every((byte, index) => byte === expected[index])).toBe(true);
    expect(encode.mock.calls.every(([input]) => input!.length <= 16 * 1024)).toBe(true);
    expect(encode.mock.calls.reduce((total, [input]) => total + input!.length, 0)).toBe(text.length);
    await handle.close();
  });
});

describe('GeneratedTextFileHandle lifetime', () => {
  it('closes before rendering starts and does not resurrect the handle', async () => {
    const render = vi.fn(async () => 'input');
    const handle = new GeneratedTextFileHandle({ estimatedSize: 5, readText: render });
    const operation = handle.read({ buffer: new Uint8Array(1) });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await handle.close(); await handle.close(); await rejected;
    expect(render).not.toHaveBeenCalled();
    await expect(handle.read({ buffer: new Uint8Array(0) })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(handle.stat()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each(['resolve', 'reject'] as const)('settles all waiting reads before a renderer has a late %s', async outcome => {
    const pending = Promise.withResolvers<string>();
    const render = vi.fn(() => pending.promise);
    const handle = new GeneratedTextFileHandle({ estimatedSize: 9, readText: render });
    const buffers = Array.from({ length: 4 }, () => new Uint8Array(1).fill(0xaa));
    const operations = buffers.map(buffer => handle.read({ buffer }));
    const rejected = Promise.all(operations.map(operation => expect(operation).rejects.toMatchObject({ name: 'AbortError' })));
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    await handle.close();
    await rejected;
    expect(buffers.every(buffer => buffer[0] === 0xaa)).toBe(true);
    if (outcome === 'resolve') pending.resolve('x'.repeat(4 * 1024 * 1024));
    else pending.reject(new Error('Late provider rejection'));
    await Promise.resolve(); await Promise.resolve();
    expect(encode).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledOnce();
    await expect(handle.stat()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(handle.read({ buffer: new Uint8Array(1) })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects a close racing with a resolved renderer before copying any bytes', async () => {
    const pending = Promise.withResolvers<string>();
    const render = vi.fn(() => pending.promise);
    const handle = new GeneratedTextFileHandle({ estimatedSize: 5, readText: render });
    const buffer = new Uint8Array(2).fill(0xaa);
    const operation = handle.read({ buffer });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    pending.resolve('input');
    await handle.close(); await rejected;
    expect(buffer).toEqual(new Uint8Array([0xaa, 0xaa]));
  });

  it('does not close another handle, change read-only semantics, or render for ioctl', async () => {
    const render = vi.fn(async () => 'text');
    const first = new GeneratedTextFileHandle({ estimatedSize: 5, readText: render });
    const second = new GeneratedTextFileHandle({ estimatedSize: 5, readText: render });
    expect(await first.ioctl()).toEqual({ ret: 0 });
    await expect(first.write()).rejects.toThrow('read-only');
    await expect(first.truncate()).rejects.toThrow('read-only');
    expect(render).not.toHaveBeenCalled();
    await first.close();
    const buffer = new Uint8Array(4);
    expect(await second.read({ buffer })).toEqual({ bytesRead: 4 });
    expect(new TextDecoder().decode(buffer)).toBe('text');
    await second.close();
  });
});
