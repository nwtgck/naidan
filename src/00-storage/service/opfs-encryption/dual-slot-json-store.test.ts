import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { DualSlotJsonStore } from './dual-slot-json-store';

const TestValueSchemaDto = z.object({
  formatVersion: z.literal(1),
  sequence: z.number(),
  value: z.string(),
});

type TestValueDto = z.infer<typeof TestValueSchemaDto>;

async function writeSlot({
  directory,
  slot,
  value,
}: {
  directory: FileSystemDirectoryHandle,
  slot: 0 | 1,
  value: TestValueDto,
}): Promise<void> {
  const handle = await directory.getFileHandle(`value-${slot}.json`, {
    create: true,
  });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
}

describe('DualSlotJsonStore', () => {
  it('selects the value with the greatest sequence', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'state' });
    const store = new DualSlotJsonStore({
      directory,
      filePrefix: 'value',
      schema: TestValueSchemaDto,
    });

    await writeSlot({
      directory,
      slot: 0,
      value: { formatVersion: 1, sequence: 2, value: 'older' },
    });
    await writeSlot({
      directory,
      slot: 1,
      value: { formatVersion: 1, sequence: 3, value: 'newer' },
    });

    await expect(store.read()).resolves.toEqual({
      formatVersion: 1,
      sequence: 3,
      value: 'newer',
    });
  });

  it('accepts an exact durable slot replacement when close reports an error', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'state' });
    const handle = await directory.getFileHandle('value-1.json', { create: true });
    const createWritable = handle.createWritable.bind(handle);
    vi.spyOn(handle, 'createWritable').mockImplementation(async options => {
      const writable = await createWritable(options);
      const close = writable.close.bind(writable);
      vi.spyOn(writable, 'close').mockImplementation(async () => {
        await close();
        throw new Error('simulated close error after durable replacement');
      });
      return writable;
    });
    const store = new DualSlotJsonStore({
      directory,
      filePrefix: 'value',
      schema: TestValueSchemaDto,
    });
    const value = { formatVersion: 1 as const, sequence: 1, value: 'committed' };

    await expect(store.write({ value })).resolves.toBeUndefined();
    await expect(store.read()).resolves.toEqual(value);
  });

  it('does not downgrade past a newer unsupported format', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'state' });
    const store = new DualSlotJsonStore({
      directory,
      filePrefix: 'value',
      schema: TestValueSchemaDto,
    });

    await writeSlot({
      directory,
      slot: 0,
      value: { formatVersion: 1, sequence: 2, value: 'supported older value' },
    });
    const futureHandle = await directory.getFileHandle('value-1.json', { create: true });
    const writable = await futureHandle.createWritable();
    await writable.write(JSON.stringify({
      formatVersion: 2,
      sequence: 3,
      value: 'unsupported newer value',
    }));
    await writable.close();

    await expect(store.read()).rejects.toThrow(
      'Newest dual-slot value value is not supported or is structurally invalid',
    );
  });

  it('rejects two valid slots with the same sequence', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'state' });
    const store = new DualSlotJsonStore({
      directory,
      filePrefix: 'value',
      schema: TestValueSchemaDto,
    });

    await writeSlot({
      directory,
      slot: 0,
      value: { formatVersion: 1, sequence: 4, value: 'first' },
    });
    await writeSlot({
      directory,
      slot: 1,
      value: { formatVersion: 1, sequence: 4, value: 'second' },
    });

    await expect(store.read()).rejects.toThrow(
      'Dual-slot value values have the same sequence',
    );
  });

  it('propagates OPFS I/O failures instead of treating them as a corrupt slot', async () => {
    const directory = new MockFileSystemDirectoryHandle({ name: 'state' });
    const failure = new DOMException('permission denied', 'SecurityError');
    vi.spyOn(directory, 'getFileHandle').mockRejectedValue(failure);
    const store = new DualSlotJsonStore({
      directory,
      filePrefix: 'value',
      schema: TestValueSchemaDto,
    });

    await expect(store.read()).rejects.toBe(failure);
  });

});
