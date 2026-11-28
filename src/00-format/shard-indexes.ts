import { idToRaw, toBinaryObjectId, type BinaryObjectId, type VolumeId } from '@/01-models/ids';
import type { BinaryObject, Volume } from '@/01-models/types';
import { BinaryShardIndexDtoSchema, VolumeIndexDtoSchema, type BinaryShardIndexDto, type VolumeIndexDto } from './00-dto/dto';
import type { FileLocation, ReadFileText, WriteFileText } from './file-record';
import * as layout from './01-layout/layout-entries';
import { binaryObjectToDomain, binaryObjectToDto, volumeToDomain, volumeToDto } from './mapper/mappers';

export function binaryShardIndexFormat({ parent, name }: { parent: readonly string[], name: string }) {
  async function read({ file, readText }: { file: FileLocation, readText: ReadFileText }): Promise<BinaryShardIndexDto> {
    const text = await readText({ file });
    return text === undefined ? { objects: {} } : BinaryShardIndexDtoSchema.parse(JSON.parse(text));
  }

  return {
    name,
    forId({ id }: { id: BinaryObjectId }) {
      const key = idToRaw({ id });
      const shard = layout.storageShardName({ rawId: key });
      const file = layout.entry({ parent: [...parent, shard], name });
      return {
        async read({ readText }: { readText: ReadFileText }): Promise<BinaryObject | undefined> {
          const index = await read({ file, readText });
          const dto = index.objects[key];
          return dto === undefined ? undefined : binaryObjectToDomain({ dto });
        },
        async edit({ readText }: { readText: ReadFileText }) {
          const index = await read({ file, readText });
          return {
            async put({ object, writeText }: { object: Omit<BinaryObject, 'id'>, writeText: WriteFileText }): Promise<void> {
              index.objects[key] = binaryObjectToDto({ domain: { ...object, id } });
              await writeText({ file, text: JSON.stringify(index) });
            },
            async remove({ writeText }: { writeText: WriteFileText }): Promise<void> {
              if (index.objects[key]) {
                delete index.objects[key];
                await writeText({ file, text: JSON.stringify(index) });
              }
            },
          };
        },
      };
    },
    async readShard({ shard, readText }: { shard: string, readText: ReadFileText }) {
      const file = layout.entry({ parent: [...parent, shard], name });
      const { objects } = await read({ file, readText });
      return {
        get({ id }: { id: BinaryObjectId }): BinaryObject | undefined {
          const dto = objects[idToRaw({ id })];
          return dto === undefined ? undefined : binaryObjectToDomain({ dto });
        },
        *entries(): Iterable<{ lookupId: BinaryObjectId, object: BinaryObject }> {
          // Backup reads the body at the index key even if the record has a different ID.
          for (const key of Object.keys(objects)) {
            yield { lookupId: toBinaryObjectId({ raw: key }), object: binaryObjectToDomain({ dto: objects[key]! }) };
          }
        },
      };
    },
  };
}

export function volumeShardIndexFormat({ parent, name }: { parent: readonly string[], name: string }) {
  async function read({ file, readText }: { file: FileLocation, readText: ReadFileText }): Promise<VolumeIndexDto> {
    const text = await readText({ file });
    return text === undefined ? { volumes: {} } : VolumeIndexDtoSchema.parse(JSON.parse(text));
  }

  return {
    forId({ id }: { id: VolumeId }) {
      const key = idToRaw({ id });
      const shard = layout.storageShardName({ rawId: key });
      const file = layout.entry({ parent: [...parent, shard], name });
      return {
        shard,
        shardPath: file.path.slice(0, -1),
        async read({ readText }: { readText: ReadFileText }): Promise<Volume | undefined> {
          const index = await read({ file, readText });
          const dto = index.volumes[key];
          return dto === undefined ? undefined : volumeToDomain({ dto });
        },
        async edit({ readText }: { readText: ReadFileText }) {
          const index = await read({ file, readText });
          return {
            get(): Volume | undefined {
              const dto = index.volumes[key];
              return dto === undefined ? undefined : volumeToDomain({ dto });
            },
            async put({ volume, writeText }: { volume: Omit<Volume, 'id'>, writeText: WriteFileText }): Promise<void> {
              index.volumes[key] = volumeToDto({ domain: { ...volume, id } });
              await writeText({ file, text: JSON.stringify(index) });
            },
            async rename({ name, writeText }: { name: string, writeText: WriteFileText }): Promise<void> {
              const dto = index.volumes[key];
              if (!dto) {
                throw new Error(`Volume not found: ${key}`);
              }
              index.volumes[key] = { ...dto, name };
              await writeText({ file, text: JSON.stringify(index) });
            },
            async remove({ writeText }: { writeText: WriteFileText }): Promise<void> {
              if (index.volumes[key] !== undefined) {
                delete index.volumes[key];
                await writeText({ file, text: JSON.stringify(index) });
              }
            },
          };
        },
      };
    },
    async *listShard({ shard, readText }: { shard: string, readText: ReadFileText }): AsyncIterable<Volume> {
      const file = layout.entry({ parent: [...parent, shard], name });
      const { volumes } = await read({ file, readText });
      for (const dto of Object.values(volumes)) {
        yield volumeToDomain({ dto });
      }
    },
  };
}

export const TEST_ONLY = {
};
