type Pending = {
  bytes: Uint8Array | undefined;
  resolve: ReturnType<typeof Promise.withResolvers<Response>>['resolve'];
  reject: ReturnType<typeof Promise.withResolvers<Response>>['reject'];
  cleanup: () => void;
};
type Slot = { sender: Pending | undefined; receiver: Pending | undefined };

/** Test-only finite relay: no key, stream state, or peer identity lives here. */
export class MemoryRelay {
  journalPosts = 0;
  readonly firstRecordPost = Promise.withResolvers<void>();
  private readonly slots = new Map<string, Slot>();
  private transform: ({ route, bytes }: { route: string; bytes: Uint8Array }) => Uint8Array = ({ bytes }) => bytes;
  transformReplies({ transform }: { transform: ({ route, bytes }: { route: string; bytes: Uint8Array }) => Uint8Array }): void {
    this.transform = transform;
  }
  interrupt(): number {
    const slots = [...this.slots.values()];
    this.slots.clear();
    for (const slot of slots) {
      for (const pending of [slot.sender, slot.receiver]) {
        pending?.cleanup();
        pending?.reject(new Error('In-memory relay interrupted'));
      }
    }
    return slots.length;
  }
  get occupied(): number {
    return this.slots.size;
  }
  request({ input, init }: { input: Parameters<typeof fetch>[0]; init: Parameters<typeof fetch>[1] }): Promise<Response> {
    const url = String(input), side = init?.method === 'POST' ? 'sender' : 'receiver';
    const signal = init?.signal;
    if (!signal) throw new Error('Every request needs a lifetime signal');
    signal.throwIfAborted();
    let slot = this.slots.get(url);
    if (!slot) {
      slot = { sender: undefined, receiver: undefined }; this.slots.set(url, slot);
    }
    if (slot[side]) {
      const diagnostic = (() => {
        switch (side) {
        case 'sender': return `[ERROR] Another sender has been connected on '${new URL(url).pathname}'.`;
        case 'receiver': return '[ERROR] The number of receivers has reached limits.';
        default: { const exhaustive: never = side; throw new Error(String(exhaustive)); }
        }
      })();
      return Promise.resolve(new Response(diagnostic, { status: 400 }));
    }
    const pending = Promise.withResolvers<Response>();
    const abort = () => {
      if (slot[side] === entry) slot[side] = undefined;
      if (!slot.sender && !slot.receiver) this.slots.delete(url);
      signal.removeEventListener('abort', abort);
      pending.reject(signal.reason);
    };
    const body = init?.body;
    if (body !== undefined && !(body instanceof Uint8Array)) throw new Error('Finite bytes required');
    if (body instanceof Uint8Array && body[13] === 4) this.journalPosts++;
    if (body instanceof Uint8Array && body[13] === 5) this.firstRecordPost.resolve();
    const entry: Pending = {
      bytes: body instanceof Uint8Array ? new Uint8Array(body) : undefined,
      resolve: pending.resolve,
      reject: pending.reject,
      cleanup: () => signal.removeEventListener('abort', abort),
    };
    slot[side] = entry;
    signal.addEventListener('abort', abort, { once: true });
    if (slot.sender && slot.receiver) {
      const sender = slot.sender, receiver = slot.receiver;
      sender.cleanup(); receiver.cleanup();
      this.slots.delete(url);
      sender.resolve(new Response('sent', { status: 200 }));
      receiver.resolve(new Response(new Uint8Array(this.transform({ route: url, bytes: sender.bytes ? new Uint8Array(sender.bytes) : new Uint8Array() })), { status: 200 }));
    }
    return pending.promise;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
