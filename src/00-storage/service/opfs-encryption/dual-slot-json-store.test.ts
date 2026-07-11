import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import { DualSlotJsonStore } from './dual-slot-json-store';

const TestValueSchemaDto = z.object({
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
      value: { sequence: 2, value: 'older' },
    });
    await writeSlot({
      directory,
      slot: 1,
      value: { sequence: 3, value: 'newer' },
    });

    await expect(store.read()).resolves.toEqual({
      sequence: 3,
      value: 'newer',
    });
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
      value: { sequence: 4, value: 'first' },
    });
    await writeSlot({
      directory,
      slot: 1,
      value: { sequence: 4, value: 'second' },
    });

    await expect(store.read()).rejects.toThrow(
      'Dual-slot value values have the same sequence',
    );
  });
});
