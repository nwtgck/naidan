import { isInitiator } from '@/features/naidan-piping-duplex/role';
import { ascii, equalBytes, fields, joinBytes, ownBytes, Pulse, requireValue } from '@/features/naidan-piping-duplex/bytes';
import { JournalChannel } from '@/features/naidan-piping-duplex/journal';
import type { NaidanPipingRole } from '@/features/naidan-piping-duplex/role';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function createNaidanPipingCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(random, byte => alphabet[byte & 31]).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
export function normalizeRendezvousCode({ code }: { code: string }): string {
  if (/^peer-[0-9a-f]{64}$/.test(code)) return code;
  if (/^[0-9]{4,8}$/.test(code)) return code;
  requireValue({ condition: /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/.test(code), message: 'Invalid rendezvous code shape' });
  const normalized = code.toUpperCase().replace('-', '');
  requireValue({ condition: [...normalized].every(character => alphabet.includes(character)), message: 'Invalid rendezvous alphabet' });
  return normalized;
}
export async function rendezvousRoom({ code, origin }: { code: string; origin: string }): Promise<Uint8Array<ArrayBuffer>> {
  const url = new URL(origin);
  requireValue({ condition: (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname === '/', message: 'An explicit relay origin is required' });
  return new Uint8Array(await crypto.subtle.digest('SHA-256', fields({ parts: [
    ascii({ text: 'piping-rendezvous/v2' }), ascii({ text: url.origin }), ascii({ text: normalizeRendezvousCode({ code }) }),
  ] })));
}
export async function rendezvousRoute({ room, kind, attempts }: {
  room: Uint8Array; kind: 'offer' | 'reply' | 'initiator' | 'responder'; attempts: readonly Uint8Array[];
}): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', fields({ parts: [room, ascii({ text: kind }), ...attempts] })));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** One immutable candidate. SELECT/ACK remains a prefix of every Noise advertisement. */
export class RendezvousChannel {
  readonly role: NaidanPipingRole;
  readonly routes: Readonly<{ send: string; receive: string }>;
  private readonly journal: JournalChannel;
  private readonly challenge: Uint8Array;
  private readonly digest: Promise<Uint8Array<ArrayBuffer>>;
  private readonly pulse = new Pulse();
  private disposed = false;
  private selected = false;
  private peerFlights = 0;

  private constructor({ role, room, attemptI, attemptR, challenge, routes }: {
    role: NaidanPipingRole; room: Uint8Array; attemptI: Uint8Array; attemptR: Uint8Array; challenge: Uint8Array;
    routes: { send: string; receive: string };
  }) {
    this.role = role;
    this.routes = Object.freeze(routes);
    this.challenge = ownBytes({ bytes: challenge, maxBytes: 32 });
    requireValue({ condition: this.challenge.length === 32 && this.challenge.some(Boolean), message: 'Fresh selection challenge required' });
    this.journal = new JournalChannel({ role, attemptI, attemptR });
    this.digest = crypto.subtle.digest('SHA-256', fields({ parts: [ascii({ text: 'piping-rendezvous-binding/v2' }),
      room, attemptI, attemptR, this.challenge] })).then(bytes => new Uint8Array(bytes));
    void this.digest.catch(() => {});
  }
  static async create({ role, room, attemptI, attemptR, challenge }: {
    role: NaidanPipingRole; room: Uint8Array; attemptI: Uint8Array; attemptR: Uint8Array; challenge: Uint8Array;
  }): Promise<RendezvousChannel> {
    // Own all input before hashing or deriving routes.
    const ownedRoom = ownBytes({ bytes: room, maxBytes: 32 });
    const ownedI = ownBytes({ bytes: attemptI, maxBytes: 32 });
    const ownedR = ownBytes({ bytes: attemptR, maxBytes: 32 });
    const ownedChallenge = ownBytes({ bytes: challenge, maxBytes: 32 });
    const initiator = await rendezvousRoute({ room: ownedRoom, kind: 'initiator', attempts: [ownedI, ownedR] });
    const responder = await rendezvousRoute({ room: ownedRoom, kind: 'responder', attempts: [ownedI, ownedR] });
    return new RendezvousChannel({ role, room: ownedRoom, attemptI: ownedI, attemptR: ownedR, challenge: ownedChallenge,
      routes: isInitiator({ role }) ? { send: initiator, receive: responder } : { send: responder, receive: initiator } });
  }
  private checkLive(): void {
    requireValue({ condition: !this.disposed, message: 'Rendezvous disposed' });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.journal.dispose();
    this.challenge.fill(0);
    this.pulse.fire();
  }
  get bound(): boolean {
    return this.selected;
  }
  get peerStartedNoise(): boolean {
    return this.peerFlights > 0;
  }
  get revision(): number {
    return this.pulse.revision;
  }
  waitForChange({ revision, signal }: { revision: number; signal: AbortSignal }): Promise<void> {
    return this.pulse.wait({ revision, signal });
  }
  async binding({ signal }: { signal: AbortSignal }): Promise<Uint8Array<ArrayBuffer>> {
    while (!this.selected) {
      this.checkLive();
      const revision = this.pulse.revision;
      signal.throwIfAborted();
      await this.pulse.wait({ revision, signal });
    }
    const binding = await this.digest;
    this.checkLive();
    signal.throwIfAborted();
    return binding.slice();
  }
  snapshot(): Uint8Array {
    this.checkLive();
    return joinBytes({ parts: [this.challenge, this.journal.snapshot()] });
  }
  /** Returns progress only after validating the complete immutable transcript. */
  accept({ bytes }: { bytes: Uint8Array }): boolean {
    this.checkLive();
    const input = ownBytes({ bytes, maxBytes: 16416 });
    requireValue({ condition: input.length >= 99, message: 'Selection envelope truncated' });
    if (!equalBytes({ left: input.subarray(0, 32), right: this.challenge })) return false;
    const current = this.journal.snapshot();
    if (!equalBytes({ left: input.subarray(34, 98), right: current.subarray(2, 66) })) return false;
    this.journal.accept({ bytes: input.subarray(32) });
    const count = input[98];
    if (count === undefined) throw new Error('Missing journal count');
    const changed = !this.selected || count > this.peerFlights;
    this.selected = true;
    this.peerFlights = Math.max(this.peerFlights, count);
    if (changed) this.pulse.fire();
    return changed;
  }
  async send({ bytes }: { bytes: Uint8Array }): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Rendezvous disposed'));
    if (!this.selected) return Promise.reject(new Error('Rendezvous is not bound'));
    await this.journal.send({ bytes });
    this.pulse.fire();
  }
  receive({ signal }: { signal: AbortSignal }): Promise<Uint8Array<ArrayBuffer>> {
    if (this.disposed) return Promise.reject(new Error('Rendezvous disposed'));
    if (!this.selected) return Promise.reject(new Error('Rendezvous is not bound'));
    return this.journal.receive({ signal });
  }
}

export const TEST_ONLY = {
};
