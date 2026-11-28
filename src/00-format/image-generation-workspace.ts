import type { ImageCompositionDraft, ImageGenerationCatalog, ImageGenerationRunExecution, ImageGenerationSessionDraft, ImageGenerationTagReference } from '@/01-models/image-generation';
import type { ImageGenerationStoreId } from '@/01-models/ids';
import { idToRaw, toImageGenerationRunId, toImageGenerationSessionId, toImageGenerationStoreId } from '@/01-models/ids';
import type { FileLocation } from './file-record';
import * as dtozod from '@/utils/dtozod';
import type { DtoSchema, output } from '@/utils/dtozod';
import { ExperimentalImageGenerationActivityJournalDtoSchema, ExperimentalImageGenerationBinaryDeletionDtoSchema, ExperimentalImageGenerationCatalogDtoSchema, ExperimentalImageGenerationCompositionDtoSchema, ExperimentalImageGenerationDraftDtoSchema, ExperimentalImageGenerationRunExecutionDtoSchema, ExperimentalImageGenerationTagReferenceDtoSchema } from './00-dto/experimental-image-generation.dto';
import { assertActivityJournal, initializeLegacyActivityJournal } from './image-generation-activity';
import { validateImageGenerationComposition } from './image-generation-composition';
import { imageGenerationFile, imageGenerationMetadataLimit, ImageGenerationSnapshot, parseImageGenerationRawId, type ImageGenerationIo } from './image-generation-record';
import { imageCompositionToDomain, imageCompositionToDto } from './mapper/image-generation-composition';
import { imageGenerationCatalogToDomain, imageGenerationCatalogToDto, imageGenerationDraftToDomain, imageGenerationDraftToDto, imageGenerationTagReferenceToDomain, imageGenerationTagReferenceToDto } from './mapper/image-generation';
import { entry, storageShardName } from './01-layout/layout-entries';

function workspaceRecord<S extends DtoSchema & { _zod: DtoSchema['_zod'] & { output: { revision: number } } }, T extends object>({ location, schema, toDomain, toDto, validate }: {
  location: FileLocation,
  schema: S,
  toDomain({ dto }: { dto: output<S> }): T,
  toDto({ value }: { value: T }): output<S>,
  validate?({ dto }: { dto: output<S> }): void,
}) {
  const file = imageGenerationFile({
    location,
    maxBytes: imageGenerationMetadataLimit,
    decode({ text }) {
      const dto = schema.parse(JSON.parse(text));
      validate?.({ dto });
      return dto;
    },
    encode: ({ dto }) => JSON.stringify(dto),
  });
  return {
    async read({ io }: { io: ImageGenerationIo }): Promise<ImageGenerationSnapshot<T> | undefined> {
      const dto = await file.read({ io });
      return dto === undefined ? undefined : new ImageGenerationSnapshot({ project: () => toDomain({ dto }), canonicalText: () => JSON.stringify(dto), revision: dto.revision });
    },
    prepareWrite({ value }: { value: T }) {
      const dto = schema.parse(toDto({ value }));
      validate?.({ dto });
      const prepared = file.prepare({ dto });
      return {
        snapshot: new ImageGenerationSnapshot({ project: () => toDomain({ dto }), canonicalText: () => prepared.text, revision: dto.revision }),
        write: prepared.write,
      };
    },
    readDto: file.read,
    captureForExport: file.capture,
  };
}

export function imageGenerationCatalog({ location }: { location: FileLocation }) {
  const file = workspaceRecord({
    location,
    schema: ExperimentalImageGenerationCatalogDtoSchema,
    toDomain: imageGenerationCatalogToDomain,
    toDto: ({ value }: { value: ImageGenerationCatalog }) => imageGenerationCatalogToDto({ catalog: value }),
  });
  return {
    read: file.read,
    prepareWrite: file.prepareWrite,
    async readForExport({ io }: { io: ImageGenerationIo }) {
      const catalog = await file.readDto({ io });
      return catalog && { id: toImageGenerationStoreId({ raw: catalog.id }), catalog };
    },
    prepareInitial({ id, createdAt }: { id: ImageGenerationStoreId, createdAt: number }) {
      return file.prepareWrite({ value: { id, revision: 0, createdAt, tags: [], preferences: { generationMonitorPresentation: 'visual', experimentalNoticeDismissedAt: undefined, assistantLayout: 'floating', assistantVisibility: 'closed', translation: undefined } } });
    },
  };
}

export function imageGenerationDraft({ location, sessionId }: { location: FileLocation, sessionId: string }) {
  const file = workspaceRecord({
    location,
    schema: ExperimentalImageGenerationDraftDtoSchema,
    toDomain: imageGenerationDraftToDomain,
    toDto: ({ value }: { value: ImageGenerationSessionDraft }) => imageGenerationDraftToDto({ draft: value }),
    validate({ dto }) {
      if (dto.sessionId !== sessionId) {
        throw new Error('Image Generation draft belongs to another session.');
      }
    },
  });
  return {
    read: file.read,
    prepareWrite: file.prepareWrite,
    captureForExport({ io }: { io: ImageGenerationIo }) {
      return file.captureForExport({
        io,
        decodeForRecovery({ text }) {
          const dto = ExperimentalImageGenerationDraftDtoSchema.parse(JSON.parse(text));
          if (dto.sessionId !== sessionId) {
            throw new Error('The draft belongs to another session.');
          }
          return dto;
        },
      });
    },
  };
}

export function imageGenerationCompositionDraft({ location, sessionId }: { location: FileLocation, sessionId: string }) {
  const file = workspaceRecord({
    location,
    schema: ExperimentalImageGenerationCompositionDtoSchema,
    toDomain: imageCompositionToDomain,
    toDto: ({ value }: { value: ImageCompositionDraft }) => imageCompositionToDto({ draft: value }),
    validate: ({ dto }) => validateImageGenerationComposition({ dto, sessionId }),
  });
  return {
    read: file.read,
    prepareWrite: file.prepareWrite,
    captureForExport({ io }: { io: ImageGenerationIo }) {
      return file.captureForExport({
        io,
        decodeForRecovery({ text }) {
          const dto = ExperimentalImageGenerationCompositionDtoSchema.parse(JSON.parse(text));
          // A same-session checkpoint remains recoverable when no longer editable.
          if (dto.sessionId !== sessionId) {
            throw new Error('The composition belongs to another session.');
          }
          return dto;
        },
      });
    },
  };
}

function journalToDomain({ dto }: { dto: output<typeof ExperimentalImageGenerationActivityJournalDtoSchema> }) {
  return {
    sequence: dto.sequence,
    pending: dto.pending.map(entry => ({ ...entry, sessionId: toImageGenerationSessionId({ raw: entry.sessionId }), runId: toImageGenerationRunId({ raw: entry.runId }) })),
  };
}

export type ImageGenerationActivityJournal = ReturnType<typeof journalToDomain>;

function journalToDto({ journal }: { journal: ImageGenerationActivityJournal }) {
  return ExperimentalImageGenerationActivityJournalDtoSchema.parse({
    version: 1,
    sequence: journal.sequence,
    pending: journal.pending.map(entry => ({ ...entry, sessionId: idToRaw({ id: entry.sessionId }), runId: idToRaw({ id: entry.runId }) })),
  });
}

export function imageGenerationActivity({ location }: { location: FileLocation }) {
  const file = imageGenerationFile({
    location,
    maxBytes: imageGenerationMetadataLimit,
    decode: ({ text }) => ExperimentalImageGenerationActivityJournalDtoSchema.parse(JSON.parse(text)),
    encode: ({ dto }) => JSON.stringify(ExperimentalImageGenerationActivityJournalDtoSchema.parse(dto)),
  });
  return {
    name: location.name,
    async read({ io }: { io: ImageGenerationIo }): Promise<ImageGenerationActivityJournal | undefined> {
      const dto = await file.read({ io });
      if (dto === undefined) {
        return undefined;
      }
      assertActivityJournal({ journal: dto });
      return journalToDomain({ dto });
    },
    write({ io, journal }: { io: ImageGenerationIo, journal: ImageGenerationActivityJournal }) {
      const dto = journalToDto({ journal });
      assertActivityJournal({ journal: dto });
      return file.prepare({ dto }).write({ io });
    },
    initializeLegacy({ sessions, warningCount }: { sessions: readonly { activityOrder: number | undefined }[], warningCount: number }) {
      return journalToDomain({ dto: initializeLegacyActivityJournal({ sessions, warningCount }) });
    },
  };
}

export function imageGenerationBinaryDeletion({ parent, suffix }: { parent: readonly string[], suffix: string }) {
  return {
    forId({ id: raw }: { id: string }) {
      const id = parseImageGenerationRawId({ raw });
      const location = entry({ parent: [...parent, storageShardName({ rawId: id })], name: id + suffix });
      const file = imageGenerationFile({
        location,
        maxBytes: imageGenerationMetadataLimit,
        decode({ text }) {
          const marker = ExperimentalImageGenerationBinaryDeletionDtoSchema.parse(JSON.parse(text));
          if (marker.binaryObjectId !== id) {
            throw new Error('Image Generation binary deletion identity mismatch.');
          }
          return marker;
        },
        encode: ({ dto }) => JSON.stringify(ExperimentalImageGenerationBinaryDeletionDtoSchema.parse(dto)),
      });
      return {
        async isMarked({ io }: { io: ImageGenerationIo }) {
          return await file.read({ io }) !== undefined;
        },
        async mark({ io }: { io: ImageGenerationIo }) {
          const parentLocation = entry({ parent, name: storageShardName({ rawId: id }) });
          const shard = (await io.open({ location: parentLocation, create: true }))!;
          if (await file.read({ io: shard }) === undefined) {
            await file.prepare({ dto: { binaryObjectId: id } }).write({ io: shard });
          }
        },
        async captureForExport({ io }: { io: ImageGenerationIo }) {
          return (await file.capture({ io }))?.blob;
        },
      };
    },
  };
}

export function imageGenerationExecutionForStorage({ execution }: { execution: ImageGenerationRunExecution }): ImageGenerationRunExecution {
  return ExperimentalImageGenerationRunExecutionDtoSchema.parse(execution);
}

export function imageGenerationTagsForStorage({ tags }: { tags: ImageGenerationTagReference[] }): ImageGenerationTagReference[] {
  return dtozod.array(ExperimentalImageGenerationTagReferenceDtoSchema)
    .parse(tags.map(tag => imageGenerationTagReferenceToDto({ tag })))
    .map(dto => imageGenerationTagReferenceToDomain({ dto }));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
