import { z } from 'zod';
import { PROTOCOL_VERSION } from './protocol-header';
import type { ProtocolHeaderResult } from './protocol-header';

/** Finite values have an explicit memory budget; stream length is unbounded. */
export const VALUE_BYTES = 64 * 1024 * 1024;
export const FRAME_BYTES = VALUE_BYTES + 1024;
/** Independent limits: transport batching is not a wire item or source limit. */
export const WRITE_BATCH_BYTES = 1024 * 1024 + 4096;
export const BYTE_PULL_BYTES = 1024 * 1024;
export const ITEM_FRAGMENT_BYTES = 1024 * 1024;
export const REFERENCE_LIMIT = 16;
export const CALLBACK_LIMIT = 8;
export const QUEUE_BYTES = 2 * FRAME_BYTES;
export const QUEUE_FRAMES = 64;
export const codes = ['INVALID_ARGUMENT', 'METHOD_NOT_FOUND', 'METHOD_NOT_ALLOWED', 'RESOURCE_EXHAUSTED', 'HANDLER_FAILED',
  'PROTOCOL_ERROR', 'CANCELLED', 'DEADLINE_EXCEEDED', 'TRANSPORT_ERROR'] as const;
export type NaidanRpcErrorCode = typeof codes[number];
export class NaidanRpcError extends Error {
  readonly code: NaidanRpcErrorCode;

  constructor({ code, cause }: { code: NaidanRpcErrorCode; cause?: unknown }) {
    super(code, { cause }); this.name = 'NaidanRpcError'; this.code = code;
  }
}
export type NaidanRpcProtocolDiagnostic = Exclude<ProtocolHeaderResult, { kind: 'supported' }> | { readonly kind: 'malformed-advertisement'; readonly availableBytes: number };
/** Local parser evidence. This error is never a public remote-error payload. */
export class NaidanRpcProtocolError extends NaidanRpcError {
  readonly diagnostic: NaidanRpcProtocolDiagnostic;
  readonly expectedVersion = PROTOCOL_VERSION;

  constructor({ diagnostic }: { diagnostic: NaidanRpcProtocolDiagnostic }) {
    super({ code: 'PROTOCOL_ERROR' }); this.name = 'NaidanRpcProtocolError'; this.diagnostic = Object.freeze({ ...diagnostic });
    switch (diagnostic.kind) {
    case 'unsupported-protocol-version': this.message = `Incompatible RPC version: received ${versionText({ version: diagnostic.version })}; expected ${versionText({ version: PROTOCOL_VERSION })}`; break;
    case 'invalid-protocol-version': this.message = `Invalid RPC version: 0x${diagnostic.version.toString(16).padStart(8, '0')}`; break;
    case 'wrong-protocol-magic': this.message = 'Unrecognized RPC protocol header'; break;
    case 'truncated-header': this.message = `Truncated RPC protocol header (${diagnostic.availableBytes}/13 bytes)`; break;
    case 'malformed-advertisement': this.message = `Invalid RPC protocol advertisement length (${diagnostic.availableBytes} bytes; expected 13)`; break;
    default: { const exhaustive: never = diagnostic; throw new Error(String(exhaustive)); }
    }
  }
}

function versionText({ version }: { version: number }): string {
  return `${version >= 0x80000000 ? 'experimental' : 'stable'} revision ${version & 0x7fffffff} (0x${version.toString(16).padStart(8, '0')})`;
}

/** Applications must explicitly opt in to exporting bounded public context.
 * Ordinary exception messages and stacks never cross the RPC boundary. */
export const publicErrorDetailsSchema = z.record(z.string().min(1).max(64), z.union([
  z.string().max(512), z.number().finite(), z.boolean(),
])).refine(value => Object.keys(value).length <= 8);
export type NaidanRpcPublicErrorDetails = z.infer<typeof publicErrorDetailsSchema>;
export class NaidanRpcPublicError extends NaidanRpcError {
  readonly details: Readonly<NaidanRpcPublicErrorDetails>;

  constructor({ code, details }: { code: NaidanRpcErrorCode; details: NaidanRpcPublicErrorDetails }) {
    super({ code }); this.name = 'NaidanRpcPublicError';
    this.details = Object.freeze(publicErrorDetailsSchema.parse(details));
  }
}

/** Display application-supplied context without interpreting its domain. */
export function describeNaidanRpcError({ error }: { error: unknown }): string {
  if (error instanceof NaidanRpcProtocolError) return error.message;
  if (error instanceof NaidanRpcPublicError) return `RPC code: ${error.code}\nReported details:\n${JSON.stringify(error.details, undefined, 2)}`;
  if (error instanceof NaidanRpcError) return `RPC code: ${error.code}`;
  if (error instanceof z.ZodError) return `Validation error:\n${error.issues.map(issue => `${issue.path.map(String).join('.')}: ${issue.message}`).join('\n').slice(0, 1024)}`;
  return `Detail: ${(error instanceof Error ? error.message : String(error)).slice(0, 1024)}`;
}

export function check({ condition, code }: { condition: unknown; code: NaidanRpcErrorCode }): void {
  if (!condition) throw new NaidanRpcError({ code });
}

export function deferred<T>() {
  let resolve!: ReturnType<typeof Promise.withResolvers<T>>['resolve'];
  let reject!: ReturnType<typeof Promise.withResolvers<T>>['reject'];
  const promise = new Promise<T>((yes, no) => {
    resolve = yes; reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export function ownBytes({ bytes }: { bytes: Uint8Array }): Uint8Array<ArrayBuffer> {
  check({ condition: bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer, code: 'INVALID_ARGUMENT' });
  return new Uint8Array(bytes);
}

export function validName({ name }: { name: string }): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(name) && !['then', '__proto__', 'prototype', 'constructor'].includes(name);
}

export function validKey({ key }: { key: string }): boolean {
  return !['__proto__', 'prototype', 'constructor'].includes(key);
}

export function duration({ milliseconds }: { milliseconds: number }): void {
  check({ condition: Number.isSafeInteger(milliseconds) && milliseconds >= 1 && milliseconds <= 2147483647, code: 'INVALID_ARGUMENT' });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
