import type { ImageGenerationRecord, ImageGenerationSummary } from '@/01-models/image-generation-history';
import { idToRaw, toBinaryObjectId, type BinaryObjectId, type ImageGenerationId } from '@/01-models/ids';
import * as dtozod from '@/utils/dtozod';
import { ExperimentalImageGenerationDtoSchema, ExperimentalImageGenerationIndexDtoSchema, unavailableDirectRpcRecord, type ExperimentalImageGenerationDto, type ExperimentalImageGenerationSummaryDto } from './00-dto/experimental-image-generation.dto';
import type { FileLocation } from './file-record';
import { imageGenerationToIndexSummary } from './image-generation-index';
import { imageGenerationFile, imageGenerationRecordCodec, parseImageGenerationRawId, UnavailableRpcRecordError, type ImageGenerationIo } from './image-generation-record';
import { entry, storageShardName } from './01-layout/layout-entries';
import { imageGenerationSummaryToDomain, imageGenerationToDomain, imageGenerationToDto } from './mapper/image-generation-history';

// The legacy intent is a single-field identity object.
const deletionSchema = dtozod.object({ id: dtozod.string() });

export function imageGenerationHistory({ parent, recordSuffix, indexName, deletionSuffix }: {
  parent: readonly string[], recordSuffix: string, indexName: string, deletionSuffix: string,
}) {
  function shardLocation({ rawId }: { rawId: string }) {
    return entry({ parent, name: storageShardName({ rawId }) });
  }

  function recordFile({ rawId }: { rawId: string }) {
    const location = entry({ parent: shardLocation({ rawId }).path, name: rawId + recordSuffix });
    const codec = imageGenerationRecordCodec<ExperimentalImageGenerationDto>({
      parse: ({ value }) => ExperimentalImageGenerationDtoSchema.parse(value),
      rawId,
      recordId: ({ record }) => record.id,
      unavailableRecord: unavailableDirectRpcRecord,
      identityError: 'Image generation record identity does not match its filename',
    });
    return imageGenerationFile({ location, maxBytes: undefined, decode: codec.toDto, encode: codec.toJsonText });
  }

  function deletionMarker({ rawId }: { rawId: string }) {
    const location = entry({ parent: shardLocation({ rawId }).path, name: rawId + deletionSuffix });
    return imageGenerationFile({
      location,
      maxBytes: undefined,
      decode({ text }) {
        const raw: unknown = JSON.parse(text);
        const marker = deletionSchema.parse(raw);
        if (Object.keys(raw as object).length !== 1 || marker.id !== rawId) {
          throw new Error('Image history deletion identity mismatch');
        }
        return marker;
      },
      encode: ({ dto }) => JSON.stringify(dto),
    });
  }

  function listedRecordId({ name, kind, shard }: { name: string, kind: 'file' | 'directory', shard: string }) {
    if (kind !== 'file' || name === indexName || !name.endsWith(recordSuffix)) {
      return undefined;
    }
    const id = parseImageGenerationRawId({ raw: name.slice(0, -recordSuffix.length) });
    if (storageShardName({ rawId: id }) !== shard) {
      throw new Error('Image generation record is in the wrong shard');
    }
    return id;
  }

  function put({ index, summary }: { index: Record<string, ExperimentalImageGenerationSummaryDto>, summary: ExperimentalImageGenerationSummaryDto }) {
    Object.defineProperty(index, summary.id, { value: summary, configurable: true, enumerable: true, writable: true });
  }

  async function readAndRepairIndex({ io, shard }: { io: ImageGenerationIo, shard: FileLocation }) {
    const indexFile = imageGenerationFile({
      location: entry({ parent: shard.path, name: indexName }),
      maxBytes: undefined,
      decode: ({ text }) => ExperimentalImageGenerationIndexDtoSchema.parse(JSON.parse(text)),
      encode: ({ dto }) => JSON.stringify(dto),
    });
    const index = await indexFile.read({ io }) ?? { generations: {} };
    const files = new Set<string>();
    for await (const item of io.entries()) {
      const rawId = listedRecordId({ ...item, shard: shard.name });
      if (rawId !== undefined) {
        files.add(rawId);
      }
    }
    let changed = false;
    for (const [rawId, summary] of Object.entries(index.generations)) {
      if (summary.id !== rawId || storageShardName({ rawId }) !== shard.name) {
        throw new Error('Image generation index identity mismatch');
      }
      if (!files.has(rawId)) {
        delete index.generations[rawId];
        changed = true;
      }
    }
    const unavailable: string[] = [];
    for (const rawId of files) {
      try {
        const record = await recordFile({ rawId }).read({ io });
        if (!record) {
          throw new Error('Image generation record disappeared during index recovery');
        }
        const summary = imageGenerationToIndexSummary({ record });
        if (JSON.stringify(index.generations[rawId]) !== JSON.stringify(summary)) {
          put({ index: index.generations, summary });
          changed = true;
        }
      } catch (error) {
        if (!(error instanceof UnavailableRpcRecordError)) {
          throw error;
        }
        unavailable.push(rawId);
        if (Object.hasOwn(index.generations, rawId)) {
          delete index.generations[rawId];
          changed = true;
        }
      }
    }
    const writeIndex = () => indexFile.prepare({ dto: index }).write({ io });
    if (changed) {
      await writeIndex();
    }
    return { index, unavailable, writeIndex };
  }

  return {
    async load({ io, id }: { io: ImageGenerationIo, id: ImageGenerationId }) {
      const rawId = parseImageGenerationRawId({ raw: idToRaw({ id }) });
      const shard = await io.open({ location: shardLocation({ rawId }), create: false });
      const dto = shard && await recordFile({ rawId }).read({ io: shard });
      return dto && imageGenerationToDomain({ dto });
    },
    prepareWrite({ value }: { value: ImageGenerationRecord }) {
      const dto = ExperimentalImageGenerationDtoSchema.parse(imageGenerationToDto({ record: value }));
      const rawId = dto.id;
      return {
        async write({ io: root, beforeCommit }: {
          io: ImageGenerationIo, beforeCommit({ binaryIds }: { binaryIds: BinaryObjectId[] }): Promise<void>,
        }) {
          const shard = shardLocation({ rawId });
          const io = (await root.open({ location: shard, create: true }))!;
          if (await deletionMarker({ rawId }).read({ io }) !== undefined) {
            throw new Error('This image history record was deleted');
          }
          const { index, writeIndex } = await readAndRepairIndex({ io, shard });
          const file = recordFile({ rawId });
          const existing = await file.read({ io });
          // Compare the projected persisted values, independently of domain defaults.
          if (existing && JSON.stringify(existing) !== JSON.stringify(dto)) {
            throw new Error('Image generation records are immutable');
          }
          await beforeCommit({
            binaryIds: [dto.result.binaryObjectId,
              ...dto.previews.map(image => image.binaryObjectId),
              ...(dto.request.imageInputs.initImage ? [dto.request.imageInputs.initImage.binaryObjectId] : []),
              ...dto.request.imageInputs.referenceImages.map(image => image.binaryObjectId)].map(raw => toBinaryObjectId({ raw })),
          });
          if (!existing) {
            await file.prepare({ dto }).write({ io });
          }
          put({ index: index.generations, summary: imageGenerationToIndexSummary({ record: dto }) });
          await writeIndex();
        },
      };
    },
    async remove({ io: root, id }: { io: ImageGenerationIo, id: ImageGenerationId }) {
      const rawId = parseImageGenerationRawId({ raw: idToRaw({ id }) });
      const shard = shardLocation({ rawId });
      const io = await root.open({ location: shard, create: true, allowMissing: true });
      if (!io) {
        return;
      }
      const { index, writeIndex } = await readAndRepairIndex({ io, shard });
      const file = recordFile({ rawId });
      const existing = await file.read({ io });
      const marker = deletionMarker({ rawId });
      // Acknowledgement may be lost. Keep the durable intent before deleting metadata.
      if (await marker.read({ io }) === undefined) {
        await marker.prepare({ dto: { id: rawId } }).write({ io });
      }
      if (existing) {
        await io.remove({ location: file.file, recursive: false });
      }
      delete index.generations[rawId];
      await writeIndex();
    },
    async *list({ io, warn }: {
      io: ImageGenerationIo, warn({ path, cause }: { path: string, cause: unknown }): void,
    }): AsyncIterable<ImageGenerationSummary> {
      for await (const item of io.entries()) {
        if (item.kind !== 'directory' || !/^[a-z0-9_-]{2}$/.test(item.name)) {
          continue;
        }
        const shard = entry({ parent, name: item.name });
        const directory = item.directory();
        try {
          const { index, unavailable } = await readAndRepairIndex({ io: directory, shard });
          for (const id of unavailable) {
            warn({ path: `${shard.name}/${recordFile({ rawId: id }).file.name}`, cause: new UnavailableRpcRecordError({ id }) });
          }
          for (const dto of Object.values(index.generations)) {
            yield imageGenerationSummaryToDomain({ dto });
          }
          continue;
        } catch (cause) {
          warn({ path: shard.name, cause });
        }

        // Preserve corrupt bytes and report every readable result in this shard.
        try {
          for await (const recordEntry of directory.entries()) {
            try {
              const rawId = listedRecordId({ ...recordEntry, shard: shard.name });
              if (rawId === undefined) {
                continue;
              }
              const record = await recordFile({ rawId }).read({ io: directory });
              if (!record) {
                throw new Error('Image generation record disappeared during history reading');
              }
              yield imageGenerationSummaryToDomain({ dto: imageGenerationToIndexSummary({ record }) });
            } catch (cause) {
              warn({ path: `${shard.name}/${recordEntry.name}`, cause });
            }
          }
        } catch (cause) {
          warn({ path: shard.name, cause });
        }
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
