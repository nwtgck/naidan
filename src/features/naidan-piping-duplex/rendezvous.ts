import { isInitiator } from '@/features/naidan-piping-duplex/role';
import { journalEnvelopeSchema } from '@/features/naidan-piping-duplex/schemas';
import { ascii, equalBytes, fields, ownBytes, Pulse, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { JournalChannel } from '@/features/naidan-piping-duplex/journal';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function createNaidanPipingCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(random, byte => alphabet[byte & 31]).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
export function normalizeRendezvousCode({ code }: {
    code: string;
}): string {
  // A pinned-identity rendezvous has a full hash namespace; it is never a human authentication code.
  if (/^peer-[0-9a-f]{64}$/.test(code)) return code;
  if (/^[0-9]{4,8}$/.test(code)) return code;
  requireValue({ condition: /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(code), message: 'Invalid rendezvous code shape' });
  const normalized = code.toUpperCase().replace('-', '');
  requireValue({ condition: [...normalized].every(character => alphabet.includes(character)), message: 'Invalid rendezvous alphabet' });
  return normalized;
}
function base64url({ bytes }: {
    bytes: Uint8Array;
}): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
async function digest({ bytes }: {
    bytes: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}
function nonzero({ bytes }: {
    bytes: Uint8Array;
}): boolean {
  return bytes.some(Boolean);
}
/** Public short-code discovery. It provides binding, not peer authentication. */
export class RendezvousChannel {
  readonly routes: Readonly<{
        send: string;
        receive: string;
    }>;
  private internalDisposed = false;
  private internalRole: NaidanPipingRole;
  private internalRoom: Uint8Array;
  private internalLocal: Uint8Array;
  private internalJournal: JournalChannel | undefined;
  private internalBinding: Promise<Uint8Array> | undefined;
  private internalPulse = new Pulse();
  private constructor({ role, room, local, routes }: {
        role: NaidanPipingRole;
        room: Uint8Array;
        local: Uint8Array;
        routes: {
            send: string;
            receive: string;
        };
    }) {
    this.internalRole = role; this.internalRoom = room; this.internalLocal = local; this.routes = Object.freeze({ ...routes });
  }
  static async create({ role, code, origin }: {
        role: NaidanPipingRole;
        code: string;
        origin: string;
    }): Promise<RendezvousChannel> {
    requireValue({ condition: isInitiator({ role: role }) || !isInitiator({ role: role }), message: 'Invalid role' });
    const url = new URL(origin);
    requireValue({ condition: (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password &&
                !url.search && !url.hash && url.pathname === '/', message: 'An explicit relay origin is required' });
    const room = fields({ parts: [ascii({ text: 'piping-rendezvous/v1' }), ascii({ text: url.origin }),
      ascii({ text: normalizeRendezvousCode({ code }) })] });
    const first = base64url({ bytes: await digest({ bytes: fields({ parts: [room, new Uint8Array([1])] }) }) });
    const second = base64url({ bytes: await digest({ bytes: fields({ parts: [room, new Uint8Array([2])] }) }) });
    let local: Uint8Array;
    do {
      local = crypto.getRandomValues(new Uint8Array(32));
    } while (!nonzero({ bytes: local }));
    return new RendezvousChannel({ role, room, local,
      routes: { send: isInitiator({ role: role }) ? first : second, receive: isInitiator({ role: role }) ? second : first } });
  }
  private internalCheckLive(): void {
    requireValue({ condition: !this.internalDisposed, message: 'Rendezvous disposed' });
  }
  dispose(): void {
    if (this.internalDisposed)
      return;
    this.internalDisposed = true;
    this.internalJournal?.dispose();
    this.internalJournal = undefined;
    this.internalBinding = undefined;
    this.internalLocal.fill(0);
    this.internalRoom.fill(0);
    this.internalPulse.fire();
  }
  get bound(): boolean {
    return this.internalJournal !== undefined;
  }
  async binding({ signal }: {
        signal: AbortSignal;
    }): Promise<Uint8Array<ArrayBuffer>> {
    while (!this.internalBinding) {
      this.internalCheckLive();
      const revision = this.internalPulse.revision;
      signal.throwIfAborted();
      await this.internalPulse.wait({ revision, signal });
    }
    const binding = await this.internalBinding;
    this.internalCheckLive();
    signal.throwIfAborted();
    return binding.slice();
  }
  private internalBind({ attemptI, attemptR }: {
        attemptI: Uint8Array;
        attemptR: Uint8Array;
    }): void {
    requireValue({ condition: !this.internalJournal, message: 'Rendezvous already bound' });
    this.internalJournal = new JournalChannel({ role: this.internalRole, attemptI, attemptR });
    this.internalBinding = digest({ bytes: fields({ parts: [ascii({ text: 'piping-rendezvous-binding/v1' }), this.internalRoom, attemptI, attemptR] }) });
    void this.internalBinding.catch(() => { });
    this.internalPulse.fire();
  }
  snapshot(): Uint8Array | undefined {
    this.internalCheckLive();
    if (this.internalJournal)
      return this.internalJournal.snapshot();
    if (!isInitiator({ role: this.internalRole }))
      return undefined;
    const hello = new Uint8Array(67);
    hello[0] = 1;
    hello[1] = 1;
    hello.set(this.internalLocal, 2);
    return hello;
  }
  accept({ bytes }: {
        bytes: Uint8Array;
    }): void {
    this.internalCheckLive();
    const input = ownBytes({ bytes, maxBytes: 16384 });
    journalEnvelopeSchema.parse({ version: input[0], role: input[1], count: input[66],
      attemptI: input.slice(2, 34), attemptR: input.slice(34, 66) });
    requireValue({ condition: input.length >= 67 && input[0] === 1 && input[1] === (isInitiator({ role: this.internalRole }) ? 2 : 1),
      message: 'Discovery envelope role/version' });
    const attemptI = input.slice(2, 34), attemptR = input.slice(34, 66);
    requireValue({ condition: nonzero({ bytes: attemptI }), message: 'Discovery needs an initiator attempt' });
    const initial = !nonzero({ bytes: attemptR });
    if (initial) {
      requireValue({ condition: !isInitiator({ role: this.internalRole }) && input.length === 67 && input[66] === 0, message: 'Invalid initial HELLO' });
      if (!this.internalJournal)
        this.internalBind({ attemptI, attemptR: this.internalLocal });
      // A delayed initial advertisement never replaces the selected pair or the cryptographic state.
      return;
    }
    if (!this.internalJournal) {
      if (!isInitiator({ role: this.internalRole }) || !equalBytes({ left: attemptI, right: this.internalLocal }))
        return;
      // Validate the complete advertisement before committing the selected peer attempt.
      const candidate = new JournalChannel({ role: this.internalRole, attemptI, attemptR });
      candidate.accept({ bytes: input });
      this.internalBind({ attemptI, attemptR });
    }
    const selected = this.internalJournal?.snapshot();
    if (!selected || !equalBytes({ left: input.subarray(2, 66), right: selected.subarray(2, 66) }))
      return;
    this.internalJournal?.accept({ bytes: input });
  }
  send({ bytes }: {
        bytes: Uint8Array;
    }): Promise<void> {
    if (this.internalDisposed)
      return Promise.reject(new Error('Rendezvous disposed'));
    if (!this.internalJournal)
      return Promise.reject(new Error('Rendezvous is not bound'));
    return this.internalJournal.send({ bytes });
  }
  receive({ signal }: {
        signal: AbortSignal;
    }): Promise<Uint8Array<ArrayBuffer>> {
    if (this.internalDisposed)
      return Promise.reject(new Error('Rendezvous disposed'));
    if (!this.internalJournal)
      return Promise.reject(new Error('Rendezvous is not bound'));
    return this.internalJournal.receive({ signal });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
