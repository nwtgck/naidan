import { idToRaw, type NaidanId } from '@/01-models/ids';
import type { ImageGenerationReadResult, ImageGenerationReadWarning } from '@/01-models/image-generation';
import type { DtoSchema } from '@/utils/dtozod';
import type { FileLocation } from './file-record';
import { imageGenerationFile, imageGenerationMetadataLimit, imageGenerationRecordCodec, ImageGenerationSnapshot, parseImageGenerationRawId, UnavailableRpcRecordError, type ImageGenerationIo } from './image-generation-record';
import { entry, storageShardName } from './01-layout/layout-entries';

type ImageDto<T> = DtoSchema & { readonly _zod: DtoSchema['_zod'] & { readonly output: T } };
type ImageId<T> = T extends { id: infer Id extends NaidanId } ? Id : T extends { assetId: infer Id extends NaidanId } ? Id : never;
type RecordId<T> = ({ record }: { record: T }) => string;

export function imageWorkspaceTable<D extends object, S, Record extends object, Summary, Changes = never>({ location, names, sessionDirectories, serializeBeforeOpening = false, schema, indexSchema, recordId, summaryId, summarize, toDto, toDomain, toDomainForEditing = toDomain, summaryToDomain, applyChanges, validate, unavailableRecord }: {
  location: FileLocation,
  names: { recordSuffix: string, session: string, index: string, dirty: string },
  sessionDirectories?: boolean,
  serializeBeforeOpening?: boolean,
  schema: ImageDto<D>,
  indexSchema: ImageDto<{ items: S[] }>,
  recordId: RecordId<D>,
  summaryId({ summary }: { summary: S }): string,
  summarize({ record }: { record: D }): S,
  toDto({ value }: { value: Record }): D,
  toDomain({ dto }: { dto: D }): Record,
  toDomainForEditing?({ dto }: { dto: D }): Record,
  summaryToDomain({ dto }: { dto: S }): Summary,
  applyChanges?({ dto, changes }: { dto: D, changes: Changes }): D,
  validate?: ({ record }: { record: D | S }) => void,
  unavailableRecord?: ({ raw }: { raw: unknown }) => { id: string } | undefined,
}) {
  const maxBytes = imageGenerationMetadataLimit;
  function shardLocation({ id }: { id: string }): FileLocation {
    return entry({ parent: location.path, name: storageShardName({ rawId: id }) });
  }

  function recordLocation({ id }: { id: string }) {
    const shard = shardLocation({ id });
    const directory = sessionDirectories ? entry({ parent: shard.path, name: id }) : undefined;
    const file = directory
      ? entry({ parent: directory.path, name: names.session })
      : entry({ parent: shard.path, name: id + names.recordSuffix });
    return { directory, file };
  }

  function recordFile({ id }: { id: string }) {
    const { file } = recordLocation({ id });
    const codec = imageGenerationRecordCodec<D>({
      parse: ({ value }) => schema.parse(value),
      rawId: id,
      recordId,
      unavailableRecord,
      identityError: 'Image Generation record identity does not match its location.',
      validate,
    });
    return imageGenerationFile({ location: file, maxBytes, decode: codec.toDto, encode: codec.toJsonText });
  }

  function listedId({ name, kind, shard }: { name: string, kind: 'file' | 'directory', shard: string }) {
    const candidate = (() => {
      switch (kind) {
      case 'directory': return sessionDirectories ? name : undefined;
      case 'file':
        return !sessionDirectories && name !== names.index && name.endsWith(names.recordSuffix) ? name.slice(0, -names.recordSuffix.length) : undefined;
      default: {
        const exhaustive: never = kind;
        throw new Error(String(exhaustive));
      }
      }
    })();
    if (candidate === undefined) {
      return undefined;
    }
    const id = parseImageGenerationRawId({ raw: candidate });
    if (storageShardName({ rawId: id }) !== shard) {
      throw new Error('Image Generation record is in the wrong shard.');
    }
    return id;
  }

  function indexLocation({ shard }: { shard: FileLocation }) {
    return { ...entry({ parent: shard.path, name: names.index }), maxBytes };
  }

  function dirtyLocation({ shard }: { shard: FileLocation }) {
    return { ...entry({ parent: shard.path, name: names.dirty }), maxBytes };
  }

  function snapshot({ dto, canonicalText = () => JSON.stringify(dto) }: { dto: D, canonicalText?: () => string }) {
    const revision = 'revision' in dto && typeof dto.revision === 'number' ? dto.revision : undefined;
    return new ImageGenerationSnapshot({ project: () => toDomain({ dto }), canonicalText, revision });
  }

  function prepare({ value: candidate }: { value: D }) {
    const dto = schema.parse(candidate);
    validate?.({ record: dto });
    const id = parseImageGenerationRawId({ raw: recordId({ record: dto }) });
    const file = recordFile({ id });
    let encoded: ReturnType<typeof file.prepare> | undefined;
    const encode = () => encoded ??= file.prepare({ dto });
    return { id, snapshot: snapshot({ dto, canonicalText: () => encode().text }), encode, dto };
  }

  async function openTable({ io, create }: { io: ImageGenerationIo, create: boolean }) {
    const table = await io.open({ location, create });

    async function scanShard({ io, shard, purpose }: { io: ImageGenerationIo, shard: FileLocation, purpose: 'presentation' | 'mutation' }) {
      // Even dirty indexes must parse before mutation. Keep corrupt bytes available for raw export.
      const source = await io.readText({ file: indexLocation({ shard }) });
      const indexed = new Map<string, S>();
      if (source !== undefined) {
        const index = indexSchema.parse(JSON.parse(source));
        for (const summary of index.items) {
          const id = parseImageGenerationRawId({ raw: summaryId({ summary }) });
          if (indexed.has(id) || storageShardName({ rawId: id }) !== shard.name) {
            throw new Error('Image Generation index identity mismatch.');
          }
          validate?.({ record: summary });
          indexed.set(id, summary);
        }
      }
      const dirty = await io.readText({ file: dirtyLocation({ shard }) }) !== undefined;
      const ids: string[] = [];
      for await (const item of io.entries()) {
        const id = listedId({ ...item, shard: shard.name });
        if (id !== undefined) {
          ids.push(id);
        }
      }
      const items: S[] = [], unavailable: string[] = [];
      for (const id of ids) {
        const cached = indexed.get(id);
        // Mutation must interpret canonical RPC records even with a clean cache.
        if (!dirty && cached !== undefined && (purpose === 'presentation' || unavailableRecord === undefined)) {
          items.push(cached);
          continue;
        }
        try {
          const record = await recordFile({ id }).read({ io });
          if (record === undefined) {
            throw new Error('Image Generation record is incomplete or disappeared.');
          }
          items.push(summarize({ record }));
        } catch (error) {
          if (!(error instanceof UnavailableRpcRecordError)) {
            throw error;
          }
          unavailable.push(id);
        }
      }
      return { items, unavailable };
    }

    async function readDto({ id: domainId }: { id: ImageId<Record> }) {
      const id = parseImageGenerationRawId({ raw: idToRaw({ id: domainId }) });
      const shard = await table?.open({ location: shardLocation({ id }), create: false });
      return shard && recordFile({ id }).read({ io: shard });
    }

    async function read({ id }: { id: ImageId<Record> }) {
      const dto = await readDto({ id });
      if (dto === undefined) {
        return undefined;
      }
      return Object.assign(snapshot({ dto }), {
        // Partial metadata changes retain the original parsed fields.
        prepareChanges({ changes }: { changes: Changes }) {
          if (!applyChanges) {
            throw new Error('This image generation record does not support partial updates.');
          }
          return bindWrite({ prepared: prepare({ value: applyChanges({ dto, changes }) }) });
        },
      });
    }

    async function list(): Promise<ImageGenerationReadResult<Summary>> {
      const items: Summary[] = [], warnings: ImageGenerationReadWarning[] = [];
      let warningCount = 0;
      function warn({ path, error }: { path: string, error: unknown }): void {
        warningCount++;
        if (warnings.length < 100) {
          warnings.push({ path: path.slice(0, 1024), message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) });
        }
      }
      if (!table) {
        return { items, warnings, warningCount };
      }
      for await (const item of table.entries()) {
        if (item.kind !== 'directory' || !/^[a-z0-9_-]{2}$/.test(item.name)) {
          continue;
        }
        const { name } = item;
        const io = item.directory();
        const shard = entry({ parent: location.path, name });
        try {
          const result = await scanShard({ io, shard, purpose: 'presentation' });
          items.push(...result.items.map(dto => summaryToDomain({ dto })));
          for (const id of result.unavailable) {
            warn({ path: `${name}/${id}`, error: new UnavailableRpcRecordError({ id }) });
          }
          continue;
        } catch (error) {
          warn({ path: `${name}/${names.index}`, error });
        }
        try {
          for await (const item of io.entries()) {
            try {
              const id = listedId({ ...item, shard: name });
              if (id === undefined) {
                continue;
              }
              const record = await recordFile({ id }).read({ io });
              if (record === undefined) {
                throw new Error('Image Generation record is incomplete.');
              }
              items.push(summaryToDomain({ dto: summarize({ record }) }));
            } catch (error) {
              warn({ path: `${name}/${item.name}`, error });
            }
          }
        } catch (error) {
          warn({ path: name, error });
        }
      }
      return { items, warnings, warningCount };
    }

    async function preflightWrite({ id: domainId }: { id: ImageId<Record> }): Promise<void> {
      const id = parseImageGenerationRawId({ raw: idToRaw({ id: domainId }) });
      if (!table) {
        throw new Error('Image Generation table is unavailable.');
      }
      const shard = shardLocation({ id });
      const io = await table.open({ location: shard, create: false });
      if (io) {
        await scanShard({ io, shard, purpose: 'mutation' });
      }
    }

    type AssertCurrent = ({ current, next }: { current: ImageGenerationSnapshot<Record> | undefined, next: ImageGenerationSnapshot<Record> }) => void;

    async function writePrepared({ prepared, assertCurrent, beforeCommit }: {
      prepared: ReturnType<typeof prepare>,
      assertCurrent: AssertCurrent,
      beforeCommit: () => Promise<void>,
    }): Promise<void> {
      const write = prepared.encode();
      if (!table) {
        throw new Error('Image Generation table is unavailable.');
      }
      const { id } = prepared;
      const shard = shardLocation({ id });
      const io = (await table.open({ location: shard, create: true }))!;
      const index = await scanShard({ io, shard, purpose: 'mutation' });
      const currentDto = await recordFile({ id }).read({ io });
      const current = currentDto === undefined ? undefined : snapshot({ dto: currentDto });
      assertCurrent({ current, next: prepared.snapshot });
      await beforeCommit();

      const dirty = dirtyLocation({ shard });
      await io.writeText({ file: dirty, text: 'record-first' });
      if (current === undefined || !prepared.snapshot.matches({ other: current })) {
        const { directory } = recordLocation({ id });
        const destination = directory === undefined ? io : (await io.open({ location: directory, create: true }))!;
        try {
          await write.write({ io: destination });
        } catch (error) {
          if (directory !== undefined && current === undefined) {
            try {
              await io.removeEmptyDirectory({ location: directory });
            } catch { /* Preserve the original write failure. */ }
          }
          throw error;
        }
      }
      const summaries = index.items.filter(summary => summaryId({ summary }) !== id);
      summaries.push(summarize({ record: prepared.dto }));
      const text = JSON.stringify(indexSchema.parse({ items: summaries }));
      await io.writeText({ file: indexLocation({ shard }), text });
      await io.remove({ location: dirty, recursive: false });
    }

    function bindWrite({ prepared }: { prepared: ReturnType<typeof prepare> }) {
      return {
        snapshot: prepared.snapshot,
        write({ assertCurrent, beforeCommit }: {
          assertCurrent: AssertCurrent, beforeCommit: () => Promise<void>,
        }) {
          return writePrepared({ prepared, assertCurrent, beforeCommit });
        },
      };
    }

    return {
      bindWrite,
      table: {
        read,
        async load({ id }: { id: ImageId<Record> }) {
          const dto = await readDto({ id });
          return dto && toDomain({ dto });
        },
        async loadForEditing({ id }: { id: ImageId<Record> }) {
          const dto = await readDto({ id });
          return dto && toDomainForEditing({ dto });
        },
        list,
        preflightWrite,
        prepareWrite({ value }: { value: Record }) {
          return bindWrite({ prepared: prepare({ value: toDto({ value }) }) });
        },
      },
    };
  }

  return {
    path: location.path,
    async open({ io, create }: { io: ImageGenerationIo, create: boolean }) {
      return (await openTable({ io, create })).table;
    },
    prepareWrite({ value }: { value: Record }) {
      const prepared = prepare({ value: toDto({ value }) });
      if (serializeBeforeOpening) {
        prepared.encode();
      }
      return {
        snapshot: prepared.snapshot,
        async open({ io, create }: { io: ImageGenerationIo, create: boolean }) {
          const { table, bindWrite } = await openTable({ io, create });
          return { table, write: bindWrite({ prepared }).write };
        },
      };
    },
    openFileForExport({ id: domainId, io }: { id: ImageId<Record>, io: ImageGenerationIo }) {
      const id = parseImageGenerationRawId({ raw: idToRaw({ id: domainId }) });
      return io.readFile({ file: recordLocation({ id }).file });
    },
    captureForExport({ id: domainId, io }: { id: ImageId<Record>, io: ImageGenerationIo }) {
      const id = parseImageGenerationRawId({ raw: idToRaw({ id: domainId }) });
      return recordFile({ id }).capture({ io });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
