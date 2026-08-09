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
  createReusableAuthenticatedSegmentWriter,
  type AuthenticatedSegmentWriter,
} from "./record-appender";

export type ActiveSegmentWriterReleaseDisposition = "discard" | "reuse";

export type AuthenticatedSegmentWriterLeaseUsage = Readonly<{
  appendedEncryptedFrameBytes: number;
}>;

export type AuthenticatedSegmentWriterLease = Readonly<{
  append<Value>({ append }: {
    append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<Value>;
  }): Promise<Value>;
  release({ disposition }: {
    disposition: ActiveSegmentWriterReleaseDisposition;
  }): void;
  usage(): AuthenticatedSegmentWriterLeaseUsage;
}>;

export type AuthenticatedSegmentWriterOwnerState = "closed" | "open";

/**
 * Owns one runtime-only active Segment writer for one in-memory coordinator
 * epoch. Mutation authorities receive a non-overlapping lease; they never own
 * the Segment capability itself. A failed or uncertain append leaves the
 * writer abandoned and the next lease starts with a fresh Segment.
 */
export class AuthenticatedSegmentWriterOwner {
  private readonly backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
  private readonly diagnostics: AuthenticatedStoreDiagnosticsPort | undefined;
  private readonly fileSystemId: FileSystemId;
  private readonly randomSource: RandomByteSource | undefined;
  private readonly rootKey: FileSystemRootKey;
  private readonly segmentClass: SegmentClass;
  private activeLease: symbol | undefined;
  private activeLeaseAppendedEncryptedFrameBytes = 0;
  private closeFailure: unknown | undefined;
  private pendingWriterCleanup: Promise<void> | undefined;
  private pendingWriterCleanupFailure: unknown | undefined;
  private stateValue: AuthenticatedSegmentWriterOwnerState = "open";
  private writer: AuthenticatedSegmentWriter | undefined;

  constructor({ backend, diagnostics, fileSystemId, randomSource, rootKey, segmentClass }: {
    backend: HizoFSWritableBackend<AuthenticatedHizoFSPhysicalBytes>;
    diagnostics?: AuthenticatedStoreDiagnosticsPort;
    fileSystemId: FileSystemId;
    randomSource?: RandomByteSource;
    rootKey: FileSystemRootKey;
    segmentClass: SegmentClass;
  }) {
    this.backend = backend;
    this.diagnostics = diagnostics;
    this.fileSystemId = fileSystemId;
    this.randomSource = randomSource;
    this.rootKey = rootKey;
    this.segmentClass = segmentClass;
  }

  state(): AuthenticatedSegmentWriterOwnerState {
    return this.stateValue;
  }

  private requireOpen({ operation }: { operation: string }): void {
    switch (this.stateValue) {
    case "open": return;
    case "closed": throw new Error(`cannot ${operation}: active Segment writer owner is closed`);
    default: return this.stateValue satisfies never;
    }
  }

  private async createWriter(): Promise<AuthenticatedSegmentWriter> {
    return await createReusableAuthenticatedSegmentWriter({
      backend: this.backend,
      diagnostics: this.diagnostics,
      fileSystemId: this.fileSystemId,
      randomSource: this.randomSource,
      rootKey: this.rootKey,
      segmentClass: this.segmentClass,
    });
  }

  private beginWriterCleanup({ writer }: { writer: AuthenticatedSegmentWriter }): void {
    if (this.pendingWriterCleanup !== undefined) {
      throw new Error("active Segment writer cleanup is already pending");
    }
    this.pendingWriterCleanupFailure = undefined;
    const cleanup = writer.settleAbandonment().then(
      () => undefined,
      (cause: unknown) => {
        this.pendingWriterCleanupFailure = cause;
      },
    );
    this.pendingWriterCleanup = cleanup;
  }

  private async awaitWriterCleanup(): Promise<void> {
    const cleanup = this.pendingWriterCleanup;
    if (cleanup !== undefined) {
      await cleanup;
      if (this.pendingWriterCleanup === cleanup) this.pendingWriterCleanup = undefined;
    }
    const failure = this.pendingWriterCleanupFailure;
    if (failure !== undefined) {
      throw failure;
    }
  }

  private async writerForAppend(): Promise<AuthenticatedSegmentWriter> {
    await this.awaitWriterCleanup();
    const current = this.writer;
    if (current !== undefined) {
      switch (current.state) {
      case "active": return current;
      case "abandoned":
      case "sealed": this.writer = undefined; break;
      default: current.state satisfies never;
      }
    }
    const created = await this.createWriter();
    this.writer = created;
    return created;
  }

  private async append<Value>({ append, lease }: {
    append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<Value>;
    lease: symbol;
  }): Promise<Value> {
    this.requireOpen({ operation: "append through an active Segment writer lease" });
    if (this.activeLease !== lease) throw new Error("active Segment writer lease is no longer owned");
    const measuredAppend = async ({ writer }: { writer: AuthenticatedSegmentWriter }): Promise<Value> => {
      const before = writer.persistedFrameBytes();
      const recordUsage = (): void => {
        const delta = writer.persistedFrameBytes() - before;
        if (!Number.isSafeInteger(delta) || delta < 0) {
          throw new Error("active Segment writer usage measurement is invalid");
        }
        this.activeLeaseAppendedEncryptedFrameBytes += delta;
        if (!Number.isSafeInteger(this.activeLeaseAppendedEncryptedFrameBytes)) {
          throw new Error("active Segment writer lease usage exceeds the safe integer bound");
        }
      };
      let result: Value;
      try {
        result = await append({ writer });
      } catch (cause: unknown) {
        try {
          recordUsage();
        } catch (measurementCause: unknown) {
          throw new AggregateError(
            [cause, measurementCause],
            "active Segment writer append and usage measurement both failed",
          );
        }
        throw cause;
      }
      recordUsage();
      return result;
    };
    const writer = await this.writerForAppend();
    try {
      return await measuredAppend({ writer });
    } catch (cause: unknown) {
      if (cause instanceof AuthenticatedSegmentCapacityError && writer.hasRecords()) {
        await writer.seal();
        this.writer = undefined;
        this.diagnostics?.recordSegmentWriterEvent?.({ observation: {
          event: "rollover",
          segmentClass: this.segmentClass,
        } });
        return await measuredAppend({ writer: await this.writerForAppend() });
      }
      switch (writer.state) {
      case "active": break;
      case "abandoned":
      case "sealed":
        this.writer = undefined;
        this.beginWriterCleanup({ writer });
        break;
      default: return writer.state satisfies never;
      }
      throw cause;
    }
  }

  acquire(): AuthenticatedSegmentWriterLease {
    this.requireOpen({ operation: "acquire an active Segment writer lease" });
    if (this.activeLease !== undefined) throw new Error("active Segment writer owner already has a lease");
    const lease = Symbol("active-segment-writer-lease");
    this.activeLease = lease;
    this.activeLeaseAppendedEncryptedFrameBytes = 0;
    let active = true;
    return {
      append: async <Value>({ append }: {
        append: ({ writer }: { writer: AuthenticatedSegmentWriter }) => Promise<Value>;
      }): Promise<Value> => {
        if (!active) throw new Error("released active Segment writer lease cannot append");
        return await this.append({ append, lease });
      },
      release: ({ disposition }) => {
        if (!active) return;
        active = false;
        if (this.activeLease !== lease) throw new Error("active Segment writer lease ownership changed unexpectedly");
        this.activeLease = undefined;
        const writer = this.writer;
        if (writer !== undefined) {
          switch (writer.state) {
          case "active": break;
          case "abandoned":
          case "sealed": this.writer = undefined; break;
          default: return writer.state satisfies never;
          }
        }
        switch (disposition) {
        case "reuse": return;
        case "discard":
          this.writer?.abandon();
          if (this.writer !== undefined) this.beginWriterCleanup({ writer: this.writer });
          this.writer = undefined;
          return;
        default: return disposition satisfies never;
        }
      },
      usage: () => Object.freeze({
        appendedEncryptedFrameBytes: this.activeLease === lease
          ? this.activeLeaseAppendedEncryptedFrameBytes
          : 0,
      }),
    };
  }

  async close(): Promise<void> {
    switch (this.stateValue) {
    case "closed":
      if (this.closeFailure !== undefined) throw this.closeFailure;
      return;
    case "open": break;
    default: return this.stateValue satisfies never;
    }
    if (this.activeLease !== undefined) {
      throw new Error("cannot close active Segment writer owner while a mutation lease is active");
    }
    this.stateValue = "closed";
    try {
      await this.awaitWriterCleanup();
      const writer = this.writer;
      this.writer = undefined;
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
    } catch (cause: unknown) {
      this.closeFailure = cause;
      throw cause;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};