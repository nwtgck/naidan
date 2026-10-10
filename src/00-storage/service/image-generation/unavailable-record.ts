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
