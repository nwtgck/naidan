import type { FileSystemId, SegmentClass } from "@/00-storage/service/hizofs/00-format";
import type {
  FileSystemRootKey,
  RandomByteSource,
} from "@/00-storage/service/hizofs/01-crypto";
import type { HizoFSWritableBackend } from "@/00-storage/service/hizofs/physical-store/backend";
import type { AuthenticatedStoreDiagnosticsPort } from "./diagnostics-hooks";
import type { AuthenticatedHizoFSPhysicalBytes } from "./physical-bytes";
import {
  AuthenticatedSegmentCapacityError,
  createAuthenticatedSegmentWriter,
  type AuthenticatedSegmentWriter,
} from "./record-appender";

export type ActiveSegmentWriterReleaseDisposition = "discard" | "reuse";

export type AuthenticatedSegmentWriterLease = Readonly<{
  append<Value>({ append }: {
    append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<Value>;
  }): Promise<Value>;
  release({ disposition }: {
    disposition: ActiveSegmentWriterReleaseDisposition;
  }): void;
}>;

export type AuthenticatedSegmentWriterOwnerState = "closed" | "open";

/**
 * Owns one runtime-only active Segment writer for one in-memory coordinator
 * epoch. Mutation authorities receive a non-overlapping lease; they never own
 * the Segment capability itself. A failed or uncertain append leaves the
 * writer abandoned and the next lease starts with a fresh Segment.
 */
export class AuthenticatedSegmentWriterOwner {
  readonly #backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  readonly #diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  readonly #fileSystemId: FileSystemId;
  readonly #randomSource: RandomByteSource | undefined;
  readonly #rootKey: FileSystemRootKey;
  readonly #segmentClass: SegmentClass;
  #activeLease: symbol | undefined;
  #state: AuthenticatedSegmentWriterOwnerState = "open";
  #writer: AuthenticatedSegmentWriter | undefined;

  constructor({ backend, diagnostics, fileSystemId, randomSource, rootKey, segmentClass }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    randomSource?: RandomByteSource;
    rootKey: FileSystemRootKey;
    segmentClass: SegmentClass;
  }) {
    this.#backend = backend;
    this.#diagnostics = diagnostics;
    this.#fileSystemId = fileSystemId;
    this.#randomSource = randomSource;
    this.#rootKey = rootKey;
    this.#segmentClass = segmentClass;
  }

  state(): AuthenticatedSegmentWriterOwnerState {
    return this.#state;
  }

  #requireOpen({ operation }: { operation: string }): void {
    switch (this.#state) {
    case "open": return;
    case "closed": throw new Error(`cannot ${operation}: active Segment writer owner is closed`);
    default: return this.#state satisfies never;
    }
  }

  async #createWriter(): Promise<AuthenticatedSegmentWriter> {
    return await createAuthenticatedSegmentWriter({
      backend: this.#backend,
      diagnostics: this.#diagnostics,
      fileSystemId: this.#fileSystemId,
      randomSource: this.#randomSource,
      rootKey: this.#rootKey,
      segmentClass: this.#segmentClass,
    });
  }

  async #writerForAppend(): Promise<AuthenticatedSegmentWriter> {
    const current = this.#writer;
    if (current !== undefined) {
      switch (current.state) {
      case "active": return current;
      case "abandoned":
      case "sealed": this.#writer = undefined; break;
      default: current.state satisfies never;
      }
    }
    const created = await this.#createWriter();
    this.#writer = created;
    return created;
  }

  async #append<Value>({ append, lease }: {
    append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<Value>;
    lease: symbol;
  }): Promise<Value> {
    this.#requireOpen({ operation: "append through an active Segment writer lease" });
    if (this.#activeLease !== lease) throw new Error("active Segment writer lease is no longer owned");
    const writer = await this.#writerForAppend();
    try {
      return await append({ writer });
    } catch (cause: unknown) {
      if (cause instanceof AuthenticatedSegmentCapacityError && writer.hasRecords()) {
        await writer.seal();
        this.#writer = undefined;
        this.#diagnostics?.recordSegmentWriterEvent?.({
          event: "rollover",
          segmentClass: this.#segmentClass,
        });
        return await append({ writer: await this.#writerForAppend() });
      }
      switch (writer.state) {
      case "active": break;
      case "abandoned":
      case "sealed": this.#writer = undefined; break;
      default: return writer.state satisfies never;
      }
      throw cause;
    }
  }

  acquire(): AuthenticatedSegmentWriterLease {
    this.#requireOpen({ operation: "acquire an active Segment writer lease" });
    if (this.#activeLease !== undefined) throw new Error("active Segment writer owner already has a lease");
    const lease = Symbol("active-segment-writer-lease");
    this.#activeLease = lease;
    let active = true;
    return {
      append: async <Value>({ append }: {
        append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<Value>;
      }): Promise<Value> => {
        if (!active) throw new Error("released active Segment writer lease cannot append");
        return await this.#append({ append, lease });
      },
      release: ({ disposition }) => {
        if (!active) return;
        active = false;
        if (this.#activeLease !== lease) throw new Error("active Segment writer lease ownership changed unexpectedly");
        this.#activeLease = undefined;
        const writer = this.#writer;
        if (writer !== undefined) {
          switch (writer.state) {
          case "active": break;
          case "abandoned":
          case "sealed": this.#writer = undefined; break;
          default: return writer.state satisfies never;
          }
        }
        switch (disposition) {
        case "reuse": return;
        case "discard":
          this.#writer?.abandon();
          this.#writer = undefined;
          return;
        default: return disposition satisfies never;
        }
      },
    };
  }

  async close(): Promise<void> {
    switch (this.#state) {
    case "closed": return;
    case "open": break;
    default: return this.#state satisfies never;
    }
    if (this.#activeLease !== undefined) {
      throw new Error("cannot close active Segment writer owner while a mutation lease is active");
    }
    this.#state = "closed";
    const writer = this.#writer;
    this.#writer = undefined;
    if (writer === undefined) return;
    switch (writer.state) {
    case "abandoned":
    case "sealed": return;
    case "active":
      if (writer.hasRecords()) {
        await writer.seal();
      } else {
        writer.abandon();
      }
      return;
    default: return writer.state satisfies never;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};