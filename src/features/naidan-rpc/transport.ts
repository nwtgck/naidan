/** The RPC layer borrows exclusive access to this iterator; it knows no relay, key or path. */
export interface NaidanRpcTransport {
  /** Logical end, independent of the physical retirement barrier below.
   * The reason is local and opaque to the transport-independent RPC engine. */
  readonly ended: Promise<{ readonly error: unknown }>;
  readonly incomingStreams: AsyncIterable<NaidanRpcDuplex>;
  readonly closed: Promise<void>;
  openStream({ signal }: { signal: AbortSignal | undefined }): Promise<NaidanRpcDuplex>;
}
export interface NaidanRpcDuplex {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  abort({ reason }: { reason: string }): void;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
