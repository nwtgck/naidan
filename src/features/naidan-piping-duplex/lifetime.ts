/** A local decision, never a peer-provided terminal-reason frame. */
export type NaidanPipingConnectionEndKind = 'local-stop' | 'peer-closed' | 'response-unconfirmed' | 'record-exhausted'
  | 'authenticated-protocol-error' | 'transport-fatal';
export type NaidanPipingConnectionEnd = Readonly<{
  kind: NaidanPipingConnectionEndKind;
  error: Error;
}>;

export type HandshakeResponseStage = 'noise-2' | 'noise-3' | 'status' | 'seed' | 'confirmation';
/** Local response policy outcome, never a received reason or proof of peer death. */
export class HandshakeResponseUnconfirmedError extends Error {
  readonly stage: HandshakeResponseStage;

  constructor({ stage }: { stage: HandshakeResponseStage }) {
    super(`Handshake response unconfirmed: ${stage}`);
    this.name = 'HandshakeResponseUnconfirmedError'; this.stage = stage;
  }
}

/** Private authenticated challenge echo was not committed within its local window. */
export class ResponseUnconfirmedError extends Error {
  constructor() {
    super('Authenticated response unconfirmed'); this.name = 'ResponseUnconfirmedError';
  }
}

/** Created only by the local record writer after its counter is consumed. */
export class RecordExhaustedError extends Error {
  constructor() {
    super('Local record number exhausted');
    this.name = 'RecordExhaustedError';
  }
}

/** Raised only after record authentication succeeded and payload validation failed. */
export class AuthenticatedProtocolError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super(cause instanceof Error ? cause.message : 'Authenticated record payload failed', { cause });
    this.name = 'AuthenticatedProtocolError';
  }
}

/** Separate from a logical connection failure: ownership could not be retired. */
export class PipingRetirementError extends Error {
  readonly logicalError: unknown;

  constructor({ cause, logicalError }: { cause: unknown; logicalError: unknown }) {
    super('Piping resource retirement failed', { cause });
    this.name = 'PipingRetirementError';
    this.logicalError = logicalError;
  }
}

/** The first decision is synchronous; promise delivery follows normal microtasks. */
export class ConnectionLifetime {
  private readonly completion = Promise.withResolvers<NaidanPipingConnectionEnd>();
  private outcome: NaidanPipingConnectionEnd | undefined;
  readonly ended = this.completion.promise;

  get end(): NaidanPipingConnectionEnd | undefined {
    return this.outcome;
  }

  commit({ kind, error }: { kind: NaidanPipingConnectionEndKind; error: unknown }): NaidanPipingConnectionEnd {
    if (this.outcome !== undefined) return this.outcome;
    this.outcome = Object.freeze({ kind, error: error instanceof Error ? error : new Error('Piping connection ended', { cause: error }) });
    this.completion.resolve(this.outcome);
    return this.outcome;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
