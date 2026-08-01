import { UINT64_MAXIMUM } from "@/00-storage/service/hizofs/00-format";
import type {
  SealedStreamingNamespaceImport,
  StreamingNamespaceImportCheckpoint,
} from "@/00-storage/service/hizofs/filesystem/bulk/streaming-namespace-import";

export type StreamingNamespaceImportJournalBinding = Readonly<{
  operationIdentity: string;
  sourceAuthorityIdentity: string;
  sourceEndpointIdentity: string;
  targetAuthorityIdentity: string;
  targetEndpointIdentity: string;
}>;

export type StreamingNamespaceImportJournalCandidate =
  | Readonly<{
      checkpoint: StreamingNamespaceImportCheckpoint;
      type: "active";
    }>
  | Readonly<{
      sealed: SealedStreamingNamespaceImport;
      type: "sealed";
    }>;

export type StreamingNamespaceImportJournalRecord = Readonly<{
  binding: StreamingNamespaceImportJournalBinding;
  candidate: StreamingNamespaceImportJournalCandidate;
  generation: bigint;
  schemaVersion: 1;
}>;

export interface StreamingNamespaceImportJournalPort {
  clear({ binding, expectedGeneration }: {
    binding: StreamingNamespaceImportJournalBinding;
    expectedGeneration: bigint;
  }): Promise<void>;
  load({ operationIdentity }: {
    operationIdentity: string;
  }): Promise<StreamingNamespaceImportJournalRecord | undefined>;
  publish({ expectedGeneration, record }: {
    expectedGeneration: bigint | undefined;
    record: StreamingNamespaceImportJournalRecord;
  }): Promise<void>;
}

export type StreamingNamespaceImportJournalErrorCode =
  | "binding_conflict"
  | "generation_exhausted"
  | "invalid_binding"
  | "invalid_record";

export class StreamingNamespaceImportJournalError extends Error {
  readonly code: StreamingNamespaceImportJournalErrorCode;

  constructor({ code, message }: { code: StreamingNamespaceImportJournalErrorCode; message: string }) {
    super(message);
    this.code = code;
    this.name = "StreamingNamespaceImportJournalError";
  }
}

function requireIdentity({ label, value }: { label: string; value: string }): string {
  if (value.length === 0) {
    throw new StreamingNamespaceImportJournalError({
      code: "invalid_binding",
      message: `${label} must not be empty`,
    });
  }
  return value;
}

function validateBinding({ binding }: { binding: StreamingNamespaceImportJournalBinding }): void {
  requireIdentity({ label: "transition operation identity", value: binding.operationIdentity });
  requireIdentity({ label: "transition source authority identity", value: binding.sourceAuthorityIdentity });
  requireIdentity({ label: "transition source endpoint identity", value: binding.sourceEndpointIdentity });
  requireIdentity({ label: "transition target authority identity", value: binding.targetAuthorityIdentity });
  requireIdentity({ label: "transition target endpoint identity", value: binding.targetEndpointIdentity });
}

function sameBinding({ left, right }: {
  left: StreamingNamespaceImportJournalBinding;
  right: StreamingNamespaceImportJournalBinding;
}): boolean {
  return left.operationIdentity === right.operationIdentity
    && left.sourceAuthorityIdentity === right.sourceAuthorityIdentity
    && left.sourceEndpointIdentity === right.sourceEndpointIdentity
    && left.targetAuthorityIdentity === right.targetAuthorityIdentity
    && left.targetEndpointIdentity === right.targetEndpointIdentity;
}

function cloneBinding({ binding }: {
  binding: StreamingNamespaceImportJournalBinding;
}): StreamingNamespaceImportJournalBinding {
  return { ...binding };
}

function cloneCandidate({ candidate }: {
  candidate: StreamingNamespaceImportJournalCandidate;
}): StreamingNamespaceImportJournalCandidate {
  return structuredClone(candidate);
}

function structurallyEqual({ left, right }: { left: unknown; right: unknown }): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array
      && right instanceof Uint8Array
      && left.byteLength === right.byteLength
      && left.every((byte, index) => byte === right[index]);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structurallyEqual({ left: value, right: right[index] }));
  }
  if (typeof left === "object" || typeof right === "object") {
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObject).sort();
    const rightKeys = Object.keys(rightObject).sort();
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && structurallyEqual({ left: leftObject[key], right: rightObject[key] }));
  }
  return false;
}

function validateCandidate({ candidate }: { candidate: StreamingNamespaceImportJournalCandidate }): void {
  switch (candidate.type) {
  case "active":
    if (candidate.checkpoint.directories.length === 0) {
      throw new StreamingNamespaceImportJournalError({
        code: "invalid_record",
        message: "active transition import journal candidate has no root directory frame",
      });
    }
    return;
  case "sealed": return;
  default: return candidate satisfies never;
  }
}

function validateRecord({ record }: { record: StreamingNamespaceImportJournalRecord }): void {
  if (record.schemaVersion !== 1 || record.generation < 0n || record.generation > UINT64_MAXIMUM) {
    throw new StreamingNamespaceImportJournalError({
      code: "invalid_record",
      message: "transition import journal record has an unsupported version or generation",
    });
  }
  validateBinding({ binding: record.binding });
  validateCandidate({ candidate: record.candidate });
}

/**
 * Serializes journal ownership around one exact transition binding.
 *
 * Generation compare-and-swap is mandatory because endpoint paths can be
 * reused by later operations. A stale owner must fail rather than overwrite or
 * clear a newer private candidate after process restart. Publication and clear
 * response loss are resolved by rereading the exact candidate generation.
 */
export class StreamingNamespaceImportJournal {
  readonly #binding: StreamingNamespaceImportJournalBinding;
  readonly #port: StreamingNamespaceImportJournalPort;
  #generation: bigint | undefined;

  private constructor({ binding, generation, port }: {
    binding: StreamingNamespaceImportJournalBinding;
    generation: bigint | undefined;
    port: StreamingNamespaceImportJournalPort;
  }) {
    this.#binding = cloneBinding({ binding });
    this.#generation = generation;
    this.#port = port;
  }

  static async open({ binding, port }: {
    binding: StreamingNamespaceImportJournalBinding;
    port: StreamingNamespaceImportJournalPort;
  }): Promise<Readonly<{
    candidate: StreamingNamespaceImportJournalCandidate | undefined;
    journal: StreamingNamespaceImportJournal;
  }>> {
    validateBinding({ binding });
    const loaded = await port.load({ operationIdentity: binding.operationIdentity });
    if (loaded !== undefined) {
      validateRecord({ record: loaded });
      if (!sameBinding({ left: loaded.binding, right: binding })) {
        throw new StreamingNamespaceImportJournalError({
          code: "binding_conflict",
          message: "transition import journal belongs to a different authority or endpoint binding",
        });
      }
    }
    return {
      candidate: loaded === undefined ? undefined : cloneCandidate({ candidate: loaded.candidate }),
      journal: new StreamingNamespaceImportJournal({
        binding,
        generation: loaded?.generation,
        port,
      }),
    };
  }

  async clear(): Promise<void> {
    if (this.#generation === undefined) return;
    const expectedGeneration = this.#generation;
    try {
      await this.#port.clear({
        binding: cloneBinding({ binding: this.#binding }),
        expectedGeneration,
      });
    } catch (cause: unknown) {
      const resolved = await this.#port.load({ operationIdentity: this.#binding.operationIdentity });
      if (resolved !== undefined) throw cause;
    }
    this.#generation = undefined;
  }

  async #publishCandidate({ candidate }: {
    candidate: StreamingNamespaceImportJournalCandidate;
  }): Promise<void> {
    if (this.#generation === UINT64_MAXIMUM) {
      throw new StreamingNamespaceImportJournalError({
        code: "generation_exhausted",
        message: "transition import journal generation is exhausted",
      });
    }
    validateCandidate({ candidate });
    const generation = (this.#generation ?? -1n) + 1n;
    const record: StreamingNamespaceImportJournalRecord = {
      binding: cloneBinding({ binding: this.#binding }),
      candidate: cloneCandidate({ candidate }),
      generation,
      schemaVersion: 1,
    };
    try {
      await this.#port.publish({ expectedGeneration: this.#generation, record });
    } catch (cause: unknown) {
      const resolved = await this.#port.load({ operationIdentity: this.#binding.operationIdentity });
      if (resolved === undefined
        || resolved.generation !== generation
        || !sameBinding({ left: resolved.binding, right: this.#binding })
        || !structurallyEqual({ left: resolved.candidate, right: candidate })) throw cause;
    }
    this.#generation = generation;
  }

  async saveActive({ checkpoint }: {
    checkpoint: StreamingNamespaceImportCheckpoint;
  }): Promise<void> {
    await this.#publishCandidate({ candidate: { checkpoint: structuredClone(checkpoint), type: "active" } });
  }

  async saveSealed({ sealed }: {
    sealed: SealedStreamingNamespaceImport;
  }): Promise<void> {
    await this.#publishCandidate({ candidate: { sealed: structuredClone(sealed), type: "sealed" } });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  sameBinding,
  structurallyEqual,
};
