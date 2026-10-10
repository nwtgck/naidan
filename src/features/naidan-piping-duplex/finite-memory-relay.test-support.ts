type Entry = {
  bytes?: Uint8Array; response: ReturnType<typeof Promise.withResolvers<Response>>;
  signal: AbortSignal; status?: ReadableStreamDefaultController<Uint8Array>;
  download?: ReadableStreamDefaultController<Uint8Array>; retireHeld?: () => void; detach(): void;
};
type Slot = { sender?: Entry; receiver?: Entry; active: boolean };

/** Finite-body subset of Piping: POST headers precede rendezvous; active paths remain exclusive.
 * No persistence, retransmission, crypto, identity, or application acknowledgement is simulated. */
export class FiniteMemoryRelay {
  readonly posts: { route: string; bytes: Uint8Array }[] = [];
  readonly gets: string[] = [];
  private readonly slots = new Map<string, Slot>();
  private readonly responses = new Set<() => void>();
  private readonly chunkBytes: number;
  holdSenderEof: (({ route, bytes }: { route: string; bytes: Uint8Array }) => Promise<void>) | undefined;
  transform: (({ bytes }: { bytes: Uint8Array }) => Uint8Array) | undefined;

  constructor({ chunkBytes = 16384 }: { chunkBytes?: number } = {}) {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new RangeError('Invalid relay fragment size');
    this.chunkBytes = chunkBytes;
  }

  get occupied(): number {
    return this.slots.size + this.responses.size;
  }

  fetch: typeof fetch = (input, init) => {
    const isPost = init?.method === 'POST';
    const route = String(input), side = isPost ? 'sender' : 'receiver', signal = init?.signal;
    if (!signal) return Promise.reject(new Error('A request signal is required'));
    signal.throwIfAborted();
    let slot = this.slots.get(route);
    if (!slot) {
      slot = { active: false }; this.slots.set(route, slot);
    }
    if (slot.active || slot[side]) return Promise.resolve(new Response('Occupied', { status: 400 }));
    if (isPost && !(init?.body instanceof Uint8Array)) return Promise.reject(new Error('Only finite raw bytes are supported'));
    const response = Promise.withResolvers<Response>(); void response.promise.catch(() => {});
    const bytes = init?.body instanceof Uint8Array ? new Uint8Array(init.body) : undefined;
    const entry: Entry = { bytes, response, signal, detach: () => signal.removeEventListener('abort', abort) };
    const abort = () => {
      entry.status?.error(signal.reason); entry.download?.error(signal.reason); response.reject(signal.reason); entry.detach(); entry.retireHeld?.();
      if (slot[side] === entry) {
        delete slot[side];
        if (slot.active) {
          const other = isPost ? slot.receiver : slot.sender;
          other?.status?.error(signal.reason); other?.download?.error(signal.reason); other?.response.reject(signal.reason); other?.detach();
          if (this.slots.get(route) === slot) this.slots.delete(route);
        } else if (!slot.sender && !slot.receiver) if (this.slots.get(route) === slot) this.slots.delete(route);
      }

    };
    slot[side] = entry; signal.addEventListener('abort', abort, { once: true });
    if (isPost) {
      this.posts.push({ route, bytes: bytes!.slice() });
      response.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          entry.status = controller; controller.enqueue(new TextEncoder().encode('Waiting for receiver\n'));
        },
        cancel: () => {
          entry.detach(); if (slot.sender === entry) {
            delete slot.sender; if (!slot.receiver) if (this.slots.get(route) === slot) this.slots.delete(route);
          } entry.retireHeld?.();
        },
      }), { status: 200 }));
    } else this.gets.push(route);
    if (slot.sender && slot.receiver) {
      slot.active = true;
      const sender = slot.sender, receiver = slot.receiver;
      const payload = this.transform ? this.transform({ bytes: sender.bytes!.slice() }) : sender.bytes!;
      const hold = this.holdSenderEof?.({ route, bytes: sender.bytes! });
      void hold?.catch(() => {});
      let offset = 0, done = false;
      const complete = () => {
        if (done) return; done = true;
        if (this.slots.get(route) === slot) this.slots.delete(route); receiver.detach();
        if (hold) {
          let pending = true;
          const release = () => {
            pending = false; this.responses.delete(stop); sender.detach(); sender.retireHeld = undefined;
          };
          const stop = () => {
            if (!pending) return;
            release(); sender.status?.error(new Error('Relay stopped'));
          };
          sender.retireHeld = release; this.responses.add(stop);
          void hold.then(() => {
            if (!pending) return;
            release(); sender.status?.close();
          }, error => {
            if (!pending) return;
            release(); sender.status?.error(error);
          });
        } else {
          sender.detach(); sender.status?.close();
        }
      };
      receiver.response.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          receiver.download = controller;
        },
        pull: controller => {
          if (offset < payload.length) {
            const end = Math.min(payload.length, offset + this.chunkBytes); controller.enqueue(payload.slice(offset, end)); offset = end;
          }
          if (offset === payload.length) {
            controller.close(); complete();
          }
        },
        cancel: () => {
          if (!done) {
            done = true; if (this.slots.get(route) === slot) this.slots.delete(route); sender.detach(); receiver.detach(); sender.status?.error(new Error('Receiver cancelled'));
          }
        },
      }), { status: 200 }));
    }
    return response.promise;
  };

  interrupt(): void {
    for (const slot of this.slots.values()) {
      for (const entry of [slot.sender, slot.receiver]) {
        const error = new Error('Relay interrupted'); entry?.status?.error(error); entry?.download?.error(error); entry?.response.reject(error); entry?.detach();
      }
    }
    this.slots.clear(); for (const stop of this.responses) stop(); this.responses.clear();
  }
}

export const TEST_ONLY = {
};
