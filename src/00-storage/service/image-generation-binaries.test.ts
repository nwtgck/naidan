import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toBinaryObjectId } from '@/01-models/ids';
import { MemoryStorageProvider } from './memory-storage';
import { publishImageGenerationBinaries } from './image-generation-binaries';
const id = toBinaryObjectId({ raw: 'image-aa' });
function file({ text, type }: { text: string, type: string }) {
  return { binaryObjectId: id, blob: new Blob([text], { type }), name: 'image.png' };
}

beforeEach(() => vi.stubGlobal('Blob', NodeBlob));

describe('publication of shared image binaries', () => {
  it('publishes before metadata references and retries without overwriting shared bytes', async () => {
    const provider = new MemoryStorageProvider(); const save = vi.spyOn(provider, 'saveFile');
    const value = file({ text: 'pixels', type: 'image/png' });
    await publishImageGenerationBinaries({ provider, referenced: [id], files: [value] });
    await publishImageGenerationBinaries({ provider, referenced: [id], files: [value] });
    expect(save).toHaveBeenCalledTimes(1);
    await expect(publishImageGenerationBinaries({ provider, referenced: [id], files: [] })).resolves.toBeUndefined();
  });

  it.each(['size', 'pixels', 'mime'] as const)('rejects changed %s even on a retry', async kind => {
    const provider = new MemoryStorageProvider(); const original = file({ text: 'pixels', type: 'image/png' });
    await publishImageGenerationBinaries({ provider, referenced: [id], files: [original] });
    const changed = file({ text: kind === 'size' ? 'longer pixels' : kind === 'pixels' ? 'PIxels' : 'pixels', type: kind === 'mime' ? 'image/webp' : 'image/png' });
    await expect(publishImageGenerationBinaries({ provider, referenced: [id], files: [changed] })).rejects.toThrow('immutable');
    expect(await (await provider.getFile({ binaryObjectId: id }))!.text()).toBe('pixels');
  });

  it('rejects duplicate, unreferenced and missing files before publishing the record', async () => {
    const provider = new MemoryStorageProvider(); const value = file({ text: 'pixels', type: 'image/png' });
    const save = vi.spyOn(provider, 'saveFile');
    await expect(publishImageGenerationBinaries({ provider, referenced: [id], files: [value, value] })).rejects.toThrow('unique');
    await expect(publishImageGenerationBinaries({ provider, referenced: [], files: [value] })).rejects.toThrow('unique');
    expect(save).not.toHaveBeenCalled();
    await expect(publishImageGenerationBinaries({ provider, referenced: [id], files: [] })).rejects.toThrow('missing');
  });

  it('rejects orphan bytes without metadata and can repair only with the supplied matching bytes', async () => {
    const memory = new MemoryStorageProvider(); const value = file({ text: 'pixels', type: 'image/png' });
    const provider = { getFile: vi.fn().mockResolvedValue(value.blob), getBinaryObject: memory.getBinaryObject.bind(memory), saveFile: memory.saveFile.bind(memory) };
    await expect(publishImageGenerationBinaries({ provider, referenced: [id], files: [] })).rejects.toThrow('unpublished');
    await publishImageGenerationBinaries({ provider, referenced: [id], files: [value] });
    expect(await memory.getBinaryObject({ binaryObjectId: id })).toMatchObject({ size: 6, mimeType: 'image/png' });
  });

  it('compares every chunk and never overwrites differing late bytes', async () => {
    const provider = new MemoryStorageProvider(); const original = file({ text: 'x'.repeat(140000), type: 'image/png' });
    await publishImageGenerationBinaries({ provider, referenced: [id], files: [original] });
    const changed = file({ text: 'x'.repeat(139999) + 'y', type: 'image/png' });
    await expect(publishImageGenerationBinaries({ provider, referenced: [id], files: [changed] })).rejects.toThrow('immutable');
  });
});
