import { isInitiator } from '@/features/naidan-piping-duplex/role';
import { journalEnvelopeSchema } from '@/features/naidan-piping-duplex/schemas';
import { Pulse, ownBytes, equalBytes, requireValue, joinBytes } from '@/features/naidan-piping-duplex/bytes';
import type { NaidanPipingHandshakeChannel } from '@/features/naidan-piping-duplex/key-context';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
/** Immutable flight journal for one already-bound pair of attempts. */
export class JournalChannel implements NaidanPipingHandshakeChannel {
  private internalRole: NaidanPipingRole;
  private internalAttemptI: Uint8Array;
  private internalAttemptR: Uint8Array;
  private internalLocal: Uint8Array[] = [];
  private internalRemote: Uint8Array[] = [];
  private internalReadIndex = 0;
  private internalPulse = new Pulse();
  private internalFailure: unknown;
  constructor({ role, attemptI, attemptR }: {
        role: NaidanPipingRole;
        attemptI: Uint8Array;
        attemptR: Uint8Array;
    }) {
    this.internalRole = role;
    this.internalAttemptI = ownBytes({ bytes: attemptI, maxBytes: 32 });
    this.internalAttemptR = ownBytes({ bytes: attemptR, maxBytes: 32 });
    requireValue({ condition: this.internalAttemptI.length === 32 && this.internalAttemptR.length === 32 && this.internalAttemptI.some(Boolean) && this.internalAttemptR.some(Boolean), message: 'Fresh bound attempts required' });
  }
  async send({ bytes }: {
        bytes: Uint8Array;
    }): Promise<void> {
    if (this.internalFailure)
      throw this.internalFailure;
    requireValue({ condition: this.internalLocal.length < 16, message: 'Handshake journal full' });
    this.internalLocal.push(ownBytes({ bytes, maxBytes: 512 }));
    this.internalPulse.fire();
  }
  async receive({ signal }: {
        signal: AbortSignal;
    }): Promise<Uint8Array<ArrayBuffer>> {
    while (true) {
      const revision = this.internalPulse.revision;
      signal.throwIfAborted();
      if (this.internalFailure)
        throw this.internalFailure;
      const bytes = this.internalRemote[this.internalReadIndex];
      if (bytes) {
        this.internalReadIndex++;
        return bytes.slice();
      }
      await this.internalPulse.wait({ revision, signal });
    }
  }
  dispose(): void {
    if (this.internalFailure)
      return;
    this.internalFailure = new Error('Journal disposed');
    this.internalLocal = [];
    this.internalRemote = [];
    this.internalAttemptI.fill(0);
    this.internalAttemptR.fill(0);
    this.internalPulse.fire();
  }
  snapshot(): Uint8Array {
    if (this.internalFailure)
      throw this.internalFailure;
    const header = new Uint8Array(66);
    header[0] = isInitiator({ role: this.internalRole }) ? 1 : 2;
    header.set(this.internalAttemptI, 1);
    header.set(this.internalAttemptR, 33);
    header[65] = this.internalLocal.length;
    const entries = this.internalLocal.map((body, index) => {
      const head = new Uint8Array(4);
      head[0] = index;
      head[1] = index < (isInitiator({ role: this.internalRole }) ? 2 : 1) ? 1 : 2;
      new DataView(head.buffer).setUint16(2, body.length, false);
      return joinBytes({ parts: [head, body] });
    });
    return joinBytes({ parts: [header, ...entries] });
  }
  accept({ bytes }: {
        bytes: Uint8Array;
    }): void {
    if (this.internalFailure)
      throw this.internalFailure;
    const input = ownBytes({ bytes, maxBytes: 8322 });
    journalEnvelopeSchema.parse({
      role: input[0],
      count: input[65],
      attemptI: input.slice(1, 33),
      attemptR: input.slice(33, 65),
    });
    requireValue({ condition: input.length >= 66 && input[0] === (isInitiator({ role: this.internalRole }) ? 2 : 1), message: 'Journal role' });
    requireValue({
      condition: equalBytes({ left: input.subarray(1, 33), right: this.internalAttemptI }) &&
                equalBytes({ left: input.subarray(33, 65), right: this.internalAttemptR }),
      message: 'Journal attempt mismatch',
    });
    const count = input[65];
    if (count === undefined || count > 16)
      throw new Error('Journal count');
    const entries: Uint8Array[] = [];
    let at = 66;
    for (let index = 0; index < count; index++) {
      requireValue({ condition: at + 4 <= input.length, message: 'Journal truncated header' });
      const length = new DataView(input.buffer).getUint16(at + 2, false);
      requireValue({
        condition: input[at] === index && input[at + 1] === (index < (isInitiator({ role: this.internalRole }) ? 1 : 2) ? 1 : 2) &&
                    length <= 512 && at + 4 + length <= input.length,
        message: 'Journal entry',
      });
      const body = input.slice(at + 4, at + 4 + length);
      at += 4 + length;
      const previous = this.internalRemote[index];
      if (previous)
        requireValue({ condition: equalBytes({ left: previous, right: body }), message: 'Conflicting journal prefix' });
      entries.push(body);
    }
    requireValue({ condition: at === input.length, message: 'Journal trailing bytes' });
    if (count > this.internalRemote.length) {
      this.internalRemote = entries;
      this.internalPulse.fire();
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
