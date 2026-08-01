type InMemoryOpfsEntry = InMemoryOpfsDirectoryHandle | InMemoryOpfsFileHandle;

export type InMemoryOpfsCapabilityProfile = "window" | "worker";

function requireNonNegativeSafeInteger({ fieldName, value }: {
  fieldName: string;
  value: number;
}): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${fieldName} must be a non-negative safe integer`);
  }
}

type InMemoryOpfsWriteCommand =
  | { readonly position: number; readonly type: "seek" }
  | { readonly size: number; readonly type: "truncate" }
  | {
      readonly data: Blob | BufferSource | string;
      readonly position?: number;
      readonly type: "write";
    };

type ClassifiedInMemoryOpfsWriteChunk =
  | { readonly command: InMemoryOpfsWriteCommand; readonly type: "command" }
  | { readonly data: Blob | BufferSource | string; readonly type: "data" };

function classifyInMemoryOpfsWriteChunk({ value }: {
  value: FileSystemWriteChunkType;
}): ClassifiedInMemoryOpfsWriteChunk {
  if (typeof value === "object" && value !== null && "type" in value) {
    const candidateType = value.type;
    if (candidateType === "seek" || candidateType === "truncate" || candidateType === "write") {
      return { command: value as InMemoryOpfsWriteCommand, type: "command" };
    }
  }
  return {
    data: value as Blob | BufferSource | string,
    type: "data",
  };
}

async function toBytes({ data }: {
  data: Blob | BufferSource | string;
}): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data);
}

export class InMemoryOpfsSyncAccessHandle {
  public closed = false;
  public flushCount = 0;
  public maximumWriteLength = Number.POSITIVE_INFINITY;

  public constructor({ file }: { file: InMemoryOpfsFileHandle }) {
    this.file = file;
  }

  private readonly file: InMemoryOpfsFileHandle;

  public close(): void {
    this.closed = true;
    this.file.open = false;
  }

  public flush(): void {
    this.requireOpen();
    this.flushCount += 1;
  }

  public getSize(): number {
    this.requireOpen();
    return this.file.bytes.byteLength;
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public read(buffer: ArrayBufferView, options?: { at?: number }): number {
    this.requireOpen();
    const target = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const at = options?.at ?? 0;
    const available = Math.max(0, Math.min(target.byteLength, this.file.bytes.byteLength - at));
    target.set(this.file.bytes.subarray(at, at + available));
    return available;
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public truncate(newSize: number): void {
    this.requireOpen();
    requireNonNegativeSafeInteger({ fieldName: "Truncate size", value: newSize });
    const next = new Uint8Array(newSize);
    next.set(this.file.bytes.subarray(0, newSize));
    this.file.commit({ bytes: next });
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public write(buffer: ArrayBufferView, options?: { at?: number }): number {
    this.requireOpen();
    const source = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const written = Math.min(source.byteLength, this.maximumWriteLength);
    const at = options?.at ?? 0;
    requireNonNegativeSafeInteger({ fieldName: "Write offset", value: at });
    const required = at + written;
    const next = required > this.file.bytes.byteLength
      ? new Uint8Array(required)
      : Uint8Array.from(this.file.bytes);
    next.set(this.file.bytes);
    next.set(source.subarray(0, written), at);
    this.file.commit({ bytes: next });
    return written;
  }

  private requireOpen(): void {
    if (this.closed) throw new DOMException("closed", "InvalidStateError");
  }
}

class InMemoryOpfsWritableStream {
  public constructor({ file, keepExistingData }: {
    file: InMemoryOpfsFileHandle;
    keepExistingData: boolean;
  }) {
    this.file = file;
    this.draft = keepExistingData ? Uint8Array.from(file.bytes) : new Uint8Array();
  }

  private readonly file: InMemoryOpfsFileHandle;
  private draft: Uint8Array;
  private position = 0;
  private settled = false;

  public async abort(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.file.writableOpen = false;
  }

  public async close(): Promise<void> {
    this.requireOpen();
    this.settled = true;
    this.file.commit({ bytes: this.draft });
    this.file.writableOpen = false;
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemWritableFileStream.seek.
  public async seek(position: number): Promise<void> {
    this.requireOpen();
    requireNonNegativeSafeInteger({ fieldName: "Seek position", value: position });
    this.position = position;
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemWritableFileStream.truncate.
  public async truncate(size: number): Promise<void> {
    this.requireOpen();
    requireNonNegativeSafeInteger({ fieldName: "Truncate size", value: size });
    const next = new Uint8Array(size);
    next.set(this.draft.subarray(0, size));
    this.draft = next;
    this.position = Math.min(this.position, size);
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors FileSystemWritableFileStream.write.
  public async write(chunk: FileSystemWriteChunkType): Promise<void> {
    this.requireOpen();
    const classified = classifyInMemoryOpfsWriteChunk({ value: chunk });
    switch (classified.type) {
    case "command": {
      const command = classified.command;
      switch (command.type) {
      case "seek":
        await this.seek(command.position);
        return;
      case "truncate":
        await this.truncate(command.size);
        return;
      case "write": {
        const position = command.position ?? this.position;
        await this.writeBytes({ data: command.data, position });
        return;
      }
      default: {
        const _exhaustive: never = command;
        throw new Error(`Unhandled OPFS write command: ${String(_exhaustive)}`);
      }
      }
    }
    case "data":
      await this.writeBytes({ data: classified.data, position: this.position });
      return;
    default: {
      const _exhaustive: never = classified;
      throw new Error(`Unhandled classified OPFS write chunk: ${String(_exhaustive)}`);
    }
    }
  }

  private requireOpen(): void {
    if (this.settled) throw new DOMException("settled", "InvalidStateError");
  }

  private async writeBytes({ data, position }: {
    data: Blob | BufferSource | string;
    position: number;
  }): Promise<void> {
    requireNonNegativeSafeInteger({ fieldName: "Write position", value: position });
    const source = await toBytes({ data });
    const required = position + source.byteLength;
    if (required > this.draft.byteLength) {
      const next = new Uint8Array(required);
      next.set(this.draft);
      this.draft = next;
    }
    this.draft.set(source, position);
    this.position = required;
  }
}

export class InMemoryOpfsFileHandle {
  public readonly kind = "file" as const;
  public bytes = new Uint8Array();
  public open = false;
  public writableOpen = false;
  public readonly sync = new InMemoryOpfsSyncAccessHandle({ file: this });

  public constructor({ capabilityProfile, name }: {
    capabilityProfile: InMemoryOpfsCapabilityProfile;
    name: string;
  }) {
    this.capabilityProfile = capabilityProfile;
    this.name = name;
  }

  public readonly name: string;
  private readonly capabilityProfile: InMemoryOpfsCapabilityProfile;
  private modifiedAt = 0;

  public commit({ bytes }: { bytes: Uint8Array }): void {
    this.bytes = Uint8Array.from(bytes);
    this.modifiedAt += 1;
  }

  public async createSyncAccessHandle(): Promise<InMemoryOpfsSyncAccessHandle> {
    switch (this.capabilityProfile) {
    case "worker": break;
    case "window": throw new DOMException("sync access unavailable", "NotSupportedError");
    default: {
      const _exhaustive: never = this.capabilityProfile;
      throw new Error(`Unhandled OPFS capability profile: ${String(_exhaustive)}`);
    }
    }
    if (this.open || this.writableOpen) throw new DOMException("already open", "InvalidStateError");
    this.open = true;
    this.sync.closed = false;
    return this.sync;
  }

  public async createWritable({ keepExistingData = false }: FileSystemCreateWritableOptions = {}): Promise<FileSystemWritableFileStream> {
    if (this.open || this.writableOpen) throw new DOMException("already open", "InvalidStateError");
    this.writableOpen = true;
    return new InMemoryOpfsWritableStream({ file: this, keepExistingData }) as unknown as FileSystemWritableFileStream;
  }

  public async getFile(): Promise<File> {
    const blob = new Blob([Uint8Array.from(this.bytes)], { type: "application/octet-stream" });
    Object.defineProperties(blob, {
      lastModified: { configurable: true, enumerable: true, value: this.modifiedAt },
      name: { configurable: true, enumerable: true, value: this.name },
      webkitRelativePath: { configurable: true, enumerable: true, value: "" },
    });
    return blob as File;
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this;
  }
}

export type InMemoryOpfsFaultHooks = Readonly<{
  beforeRemoveEntry?: ({ directoryName, name, recursive }: {
    directoryName: string;
    name: string;
    recursive: boolean;
  }) => Promise<void> | void;
}>;

export class InMemoryOpfsDirectoryHandle {
  public readonly kind = "directory" as const;
  public entriesReadCount = 0;
  readonly #entries = new Map<string, InMemoryOpfsEntry>();

  public constructor({ capabilityProfile, faultHooks, name }: {
    capabilityProfile: InMemoryOpfsCapabilityProfile;
    faultHooks?: InMemoryOpfsFaultHooks;
    name: string;
  }) {
    this.capabilityProfile = capabilityProfile;
    this.faultHooks = faultHooks;
    this.name = name;
  }

  public readonly name: string;
  private readonly capabilityProfile: InMemoryOpfsCapabilityProfile;
  private readonly faultHooks: InMemoryOpfsFaultHooks | undefined;

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<InMemoryOpfsDirectoryHandle> {
    const existing = this.#entries.get(name);
    if (existing !== undefined) {
      switch (existing.kind) {
      case "directory": return existing;
      case "file": throw new DOMException("not a directory", "TypeMismatchError");
      default: return existing satisfies never;
      }
    }
    if (options?.create !== true) throw new DOMException("missing", "NotFoundError");
    const created = new InMemoryOpfsDirectoryHandle({
      capabilityProfile: this.capabilityProfile,
      faultHooks: this.faultHooks,
      name,
    });
    this.#entries.set(name, created);
    return created;
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<InMemoryOpfsFileHandle> {
    const existing = this.#entries.get(name);
    if (existing !== undefined) {
      switch (existing.kind) {
      case "file": return existing;
      case "directory": throw new DOMException("not a file", "TypeMismatchError");
      default: return existing satisfies never;
      }
    }
    if (options?.create !== true) throw new DOMException("missing", "NotFoundError");
    const created = new InMemoryOpfsFileHandle({ capabilityProfile: this.capabilityProfile, name });
    this.#entries.set(name, created);
    return created;
  }

  public [Symbol.asyncIterator](): AsyncIterableIterator<[string, InMemoryOpfsEntry]> {
    return this.entries();
  }

  public async *entries(): AsyncIterableIterator<[string, InMemoryOpfsEntry]> {
    this.entriesReadCount += 1;
    for (const entry of this.#entries.entries()) {
      yield entry;
    }
  }

  public async *keys(): AsyncIterableIterator<string> {
    for (const key of this.#entries.keys()) {
      yield key;
    }
  }

  public async *values(): AsyncIterableIterator<InMemoryOpfsEntry> {
    for (const value of this.#entries.values()) {
      yield value;
    }
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this;
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    await this.faultHooks?.beforeRemoveEntry?.({
      directoryName: this.name,
      name,
      recursive: options?.recursive ?? false,
    });
    const entry = this.#entries.get(name);
    if (entry === undefined) throw new DOMException("missing", "NotFoundError");
    switch (entry.kind) {
    case "directory":
      if (options?.recursive !== true && entry.#entries.size > 0) {
        throw new DOMException("directory is not empty", "InvalidModificationError");
      }
      break;
    case "file": break;
    default: return entry satisfies never;
    }
    this.#entries.delete(name);
  }

  // eslint-disable-next-line local-rules-named-args/require-named-args -- File System Access API interface requires positional arguments.
  public async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    if (possibleDescendant === this) return [];
    for (const [name, entry] of this.#entries) {
      if (entry === possibleDescendant) return [name];
      switch (entry.kind) {
      case "directory": {
        const nested = await entry.resolve(possibleDescendant);
        if (nested !== null) return [name, ...nested];
        break;
      }
      case "file": break;
      default: return entry satisfies never;
      }
    }
    return null;
  }
}

export function createInMemoryOpfsStorageManager({ root }: {
  root: InMemoryOpfsDirectoryHandle;
}): Pick<StorageManager, "getDirectory"> {
  return {
    getDirectory: async () => root as unknown as FileSystemDirectoryHandle,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
