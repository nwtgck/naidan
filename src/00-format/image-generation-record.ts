import { idToRaw, type NaidanId } from '@/01-models/ids';
import type { FileLocation } from './file-record';
import { unavailableRunRpcRecord } from './00-dto/experimental-image-generation.dto';

export const imageGenerationMetadataLimit = 16 * 1024 * 1024;

type ImageFileLocation = FileLocation & { maxBytes: number | undefined };

export type ImageGenerationIo = {
  open({ location, create, allowMissing }: { location: FileLocation, create: boolean, allowMissing?: boolean }): Promise<ImageGenerationIo | undefined>,
  entries(): AsyncIterable<{ name: string, kind: 'file' } | { name: string, kind: 'directory', directory(): ImageGenerationIo }>,
  readText({ file }: { file: ImageFileLocation }): Promise<string | undefined>,
  writeText({ file, text }: { file: ImageFileLocation, text: string }): Promise<void>,
  readFile({ file }: { file: FileLocation }): Promise<Blob | undefined>,
  remove({ location, recursive }: { location: FileLocation, recursive: boolean }): Promise<void>,
  removeEmptyDirectory({ location }: { location: FileLocation }): Promise<void>,
};

export class ImageGenerationSnapshot<T extends object> {
  readonly revision: number | undefined;
  #value: T | undefined;
  #project: () => T;
  #canonicalText: () => string;

  constructor({ project, canonicalText, revision }: { project(): T, canonicalText(): string, revision: number | undefined }) {
    this.#project = project;
    this.#canonicalText = canonicalText;
    this.revision = revision;
  }

  get value(): T {
    return this.#value ??= this.#project();
  }

  matches({ other }: { other: ImageGenerationSnapshot<T> }): boolean {
    return this.#canonicalText() === other.#canonicalText();
  }
}

/** Used only to build named Image Generation operations inside the format. */
export function imageGenerationFile<T>({ location, maxBytes, decode, encode }: {
  location: FileLocation, maxBytes: number | undefined,
  decode({ text }: { text: string }): T, encode({ dto }: { dto: T }): string,
}) {
  const file = { ...location, maxBytes };
  return {
    file,
    async read({ io }: { io: ImageGenerationIo }): Promise<T | undefined> {
      const text = await io.readText({ file });
      return text === undefined ? undefined : decode({ text });
    },
    prepare({ dto }: { dto: T }) {
      const text = encode({ dto });
      return { text, write: ({ io }: { io: ImageGenerationIo }) => io.writeText({ file, text }) };
    },
    async capture({ io, decodeForRecovery = decode }: {
      io: ImageGenerationIo, decodeForRecovery?: typeof decode,
    }): Promise<{ dto: T, blob: Blob } | undefined> {
      const blob = await io.readFile({ file });
      if (blob === undefined) {
        return undefined;
      }
      if (maxBytes !== undefined && blob.size > maxBytes) {
        throw new Error(`Image Generation metadata exceeds the read limit: ${file.name}`);
      }
      return { dto: decodeForRecovery({ text: await blob.text() }), blob };
    },
  };
}

export const imageGenerationIdPattern = /^[a-zA-Z0-9_-]{2,128}$/;

export function parseImageGenerationRawId({ raw }: { raw: unknown }): string {
  if (typeof raw !== 'string' || !imageGenerationIdPattern.test(raw)) {
    throw new Error('Invalid Image Generation record ID.');
  }
  return raw;
}

export function validateImageGenerationId<T extends NaidanId>({ id }: { id: T }): T {
  parseImageGenerationRawId({ raw: idToRaw({ id }) });
  return id;
}

export function assertImageGenerationSessionIdentity({ actual, expected }: { actual: string, expected: string }): void {
  if (actual !== expected) {
    throw new Error('Image Generation record belongs to a different session.');
  }
}

export function unavailableImageGenerationRunRecord({ raw, sessionId }: { raw: unknown, sessionId: string }) {
  const unavailable = unavailableRunRpcRecord({ raw });
  if (unavailable !== undefined) {
    assertImageGenerationSessionIdentity({ actual: unavailable.sessionId, expected: sessionId });
  }
  return unavailable;
}

export function imageGenerationRecordCodec<T>({ parse, rawId, recordId, unavailableRecord, identityError, validate }: {
  parse({ value }: { value: unknown }): T,
  rawId: string,
  recordId: ({ record }: { record: T }) => string,
  unavailableRecord: (({ raw }: { raw: unknown }) => { id: string } | undefined) | undefined,
  identityError: string,
  validate?: ({ record }: { record: T }) => void,
}) {
  return {
    toDto({ text }: { text: string }): T {
      const raw: unknown = JSON.parse(text);
      const unavailable = unavailableRecord?.({ raw });
      if (unavailable !== undefined) {
        if (unavailable.id !== rawId) {
          throw new Error(identityError);
        }
        throw new UnavailableRpcRecordError({ id: rawId });
      }
      const record = parse({ value: raw });
      if (recordId({ record }) !== rawId) {
        throw new Error(identityError);
      }
      validate?.({ record });
      return record;
    },
    toJsonText({ dto }: { dto: T }): string {
      return JSON.stringify(dto);
    },
  };
}

/** Only raised after validating the common record and its storage identity. */
export class UnavailableRpcRecordError extends Error {
  readonly id: string;

  constructor({ id }: { id: string }) {
    super('Stored image record has an unsupported RPC runtime');
    this.id = id;
    this.name = 'UnavailableRpcRecordError';
  }
}

export const TEST_ONLY = {
};
