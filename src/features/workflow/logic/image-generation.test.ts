import { it, expect, vi } from 'vitest';
import { imageFixture, imageResult } from './image-generation.test-support';
import { readOutput } from './values';

it('spools PNG bytes with actual dimensions, profile and explicitly requested seed', async () => {
  await using test = imageFixture();
  const outputs = await test.execute({ overrides: {} });
  expect(outputs.image?.type).toBe('binary');
  if (outputs.image?.type !== 'binary') {
    throw new Error('Missing image');
  }
  expect(outputs.image.format).toBe('png');
  const bytes: number[] = [];
  for await (const chunk of readOutput({ output: outputs.image.output, signal: undefined })) {
    bytes.push(...chunk);
  }
  expect(new Uint8Array(bytes)).toEqual(new Uint8Array(await test.result.png.arrayBuffer()));
  expect(outputs.metadata).toEqual({ type: 'json', value: { width: 256, height: 256, modelVersion: 'fixture', uniformOutput: true, byteLength: test.result.png.size, requestedSeed: '42', profile: 'webgpu-wasm32-asyncify' } });
});

it('writes bounded chunks and does not embed the image as JSON or base64', async () => {
  await using test = imageFixture();
  const result = imageResult({ width: 256, height: 256, compression: 'uncompressed' });
  test.generate.mockResolvedValue({ result, profile: 'webgpu-wasm32-asyncify' });
  await test.execute({ overrides: {} });
  expect(test.calls.filter(call => call === 'write')).toHaveLength(Math.ceil(result.png.size / 32768));
  expect(test.store.getUsage().bytes).toBe(result.png.size);
});

it('validates image inputs before acquiring engine resources', async () => {
  await using test = imageFixture();
  await expect(test.execute({ overrides: { request: { ...test.input.request, prompt: '' } } })).rejects.toThrow();
  expect(test.generate).not.toHaveBeenCalled();
});

it.each(['mime', 'signature', 'headerDimensions', 'reportedDimensions', 'requestedDimensions', 'truncated', 'oversized'] as const)('rejects invalid %s without allocating output files', async corruption => {
  await using test = imageFixture();
  const result = { ...test.result };
  switch (corruption) {
  case 'mime': result.png = new Blob([await result.png.arrayBuffer()], { type: 'text/html' });
    break;
  case 'signature': {
    const bytes = new Uint8Array(await result.png.arrayBuffer());
    bytes[0] = 0;
    result.png = new Blob([bytes], { type: 'image/png' });
    break;
  }
  case 'headerDimensions': result.png = imageResult({ width: 128, height: 128, compression: 'small' }).png;
    break;
  case 'requestedDimensions': Object.assign(result, imageResult({ width: 128, height: 128, compression: 'small' }));
    break;
  case 'reportedDimensions': result.width = 512;
    break;
  case 'truncated': result.png = result.png.slice(0, 32, 'image/png');
    break;
  case 'oversized': result.png = new Blob([new Uint8Array(32 * 1024 * 1024)], { type: 'image/png' });
    break;
  default: {
    const exhaustive: never = corruption;
    throw new Error(String(exhaustive));
  }
  }
  test.generate.mockResolvedValue({ result, profile: 'webgpu-wasm32-asyncify' });
  await expect(test.execute({ overrides: {} })).rejects.toThrow();
  expect(test.store.getUsage().entries).toBe(0);
});

it('does not claim a native cancellation is a completed image', async () => {
  await using test = imageFixture();
  test.generate.mockResolvedValue({ result: { cancelled: true, modelResident: true }, profile: 'webgpu-wasm32-asyncify' });
  await expect(test.execute({ overrides: {} })).rejects.toThrow('stopped');
  expect(test.store.getUsage().entries).toBe(0);
});

it('does not start an already cancelled request', async () => {
  await using test = imageFixture();
  test.controller.abort(new Error('Stop'));
  await expect(test.execute({ overrides: {} })).rejects.toThrow('Stop');
  expect(test.generate).not.toHaveBeenCalled();
});

it('awaits physical engine retirement after stop and discards a late success', async () => {
  await using test = imageFixture();
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof test.generate>>>();
  test.generate.mockReturnValue(gate.promise);
  const settled = vi.fn();
  const pending = test.execute({ overrides: {} });
  const handled = pending.then(settled, settled);
  await vi.waitFor(() => expect(test.generate).toHaveBeenCalledOnce());
  test.controller.abort(new Error('Stop'));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(settled).not.toHaveBeenCalled();
  gate.resolve({ result: test.result, profile: 'webgpu-wasm32-asyncify' });
  await expect(pending).rejects.toThrow('Stop');
  await handled;
  expect(test.store.getUsage().entries).toBe(0);
});

it.each(['write', 'snapshot'] as const)('cleans an image when %s fails', async operation => {
  await using test = imageFixture();
  test.failNext({ operation, error: new Error('Disk failed') });
  await expect(test.execute({ overrides: {} })).rejects.toThrow('Disk failed');
  expect(test.store.getUsage().entries).toBe(0);
  expect(test.files.size).toBe(0);
});

it.each(['write', 'snapshot'] as const)('cleans an image stopped during %s', async operation => {
  await using test = imageFixture();
  const gate = test.pauseNext({ operation });
  const pending = test.execute({ overrides: {} });
  const handled = pending.catch(() => undefined);
  await gate.entered;
  test.controller.abort(new Error('Stop'));
  gate.release();
  await expect(pending).rejects.toThrow('Stop');
  await handled;
  expect(test.store.getUsage().entries).toBe(0);
});

export const TEST_ONLY = {
};
