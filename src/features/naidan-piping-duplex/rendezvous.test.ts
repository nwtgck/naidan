// @vitest-environment node
import { encodeDiscovery } from './envelope';
import { expect, onTestFinished, it, vi } from 'vitest';
import { RendezvousChannel, createNaidanPipingCode, normalizeRendezvousCode, rendezvousRoom, rendezvousRoute } from '@/features/naidan-piping-duplex/rendezvous';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
async function pair() {
  const inputs = {
    attemptI: crypto.getRandomValues(new Uint8Array(32)),
    attemptR: crypto.getRandomValues(new Uint8Array(32)),
    challenge: crypto.getRandomValues(new Uint8Array(32)),
  };
  const discovery = { offer: encodeDiscovery({ kind: 'offer', attemptI: inputs.attemptI, publicData: new Uint8Array() }), reply: encodeDiscovery({ kind: 'reply', attemptI: inputs.attemptI, attemptR: inputs.attemptR, publicData: new Uint8Array() }) };
  const a = await RendezvousChannel.create({
    ...inputs,
    ...discovery,
    role: 'initiator',
    room: await rendezvousRoom({ code: 'abcd-efgh', origin: 'https://RELAY.invalid:443/' }),
  });
  const b = await RendezvousChannel.create({
    ...inputs,
    ...discovery,
    role: 'responder',
    room: await rendezvousRoom({ code: 'ABCDEFGH', origin: 'https://relay.invalid' }),
  });
  onTestFinished(() => {
    a.dispose(); b.dispose();
  });
  return { a, b, inputs: { ...inputs, ...discovery } };
}
function snapshot({ channel }: { channel: RendezvousChannel }): Uint8Array {
  return channel.snapshot();
}

it('normalization handles only explicit ASCII spelling and never approximates ambiguous characters', () => {
  expect(normalizeRendezvousCode({ code: 'abcd-efgh' })).toBe('ABCDEFGH');
  for (const code of ['ABCD-EFGI', 'ABCD-EFGO', 'ABCD-EFGL', 'ABCD-EFGU', ' ABCD-EFGH', 'ＡBCD-EFGH', 'AB-CD-EFGH', 'ABCDEFG', 'ABCDEFGHI'])
    expect(() => normalizeRendezvousCode({ code })).toThrow();
  for (let index = 0; index < 100; index++) expect(createNaidanPipingCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
});

it('independent selected candidates produce reciprocal routes and a matching binding', async () => {
  const { a, b } = await pair();
  expect(a.bound).toBe(false); expect(b.bound).toBe(false);
  expect(a.routes.send).toBe(b.routes.receive); expect(a.routes.receive).toBe(b.routes.send);
  expect(a.routes.send).not.toBe(a.routes.receive); expect(Object.isFrozen(a.routes)).toBe(true);
  b.accept({ bytes: snapshot({ channel: a }) }); a.accept({ bytes: snapshot({ channel: b }) });
  const signal = new AbortController().signal;
  expect(await a.binding({ signal })).toEqual(await b.binding({ signal }));
  await a.send({ bytes: new Uint8Array([7, 8]) }); b.accept({ bytes: snapshot({ channel: a }) });
  expect(await b.receive({ signal })).toEqual(new Uint8Array([7, 8]));
  expect(b.peerStartedNoise).toBe(true);
});

it('delayed selection and unrelated attempts cannot replace a selected pair or journal', async () => {
  const { a, b } = await pair(), initial = snapshot({ channel: a });
  b.accept({ bytes: initial }); a.accept({ bytes: snapshot({ channel: b }) });
  const binding = await b.binding({ signal: new AbortController().signal });
  await b.send({ bytes: new Uint8Array([19]) }); const selected = snapshot({ channel: b });
  expect(b.accept({ bytes: initial })).toBe(false); expect(snapshot({ channel: b })).toEqual(selected);
  const other = await pair(); expect(b.accept({ bytes: snapshot({ channel: other.a }) })).toBe(false);
  expect(await b.binding({ signal: new AbortController().signal })).toEqual(binding);
  expect(snapshot({ channel: b })).toEqual(selected);
});

it('a malformed first acknowledgement cannot publish the initiator binding', async () => {
  const { a, b } = await pair();
  const bad = snapshot({ channel: b }); bad[111] = 1;
  expect(a.accept({ bytes: bad })).toBe(false); expect(a.bound).toBe(false);
  a.accept({ bytes: snapshot({ channel: b }) }); expect(a.bound).toBe(true);
});

it('an acknowledgement from a previous attempt cannot bind a new candidate', async () => {
  const first = await pair(), second = await pair();
  expect(second.a.accept({ bytes: snapshot({ channel: first.b }) })).toBe(false); expect(second.a.bound).toBe(false);
});

it('room and canonical origin separate routing and cryptographic bindings', async () => {
  const { a, inputs } = await pair();
  const other = await RendezvousChannel.create({
    ...inputs,
    role: 'responder',
    room: await rendezvousRoom({ code: 'ABCDEFGH', origin: 'https://other.invalid' }),
  });
  onTestFinished(() => other.dispose());
  other.accept({ bytes: snapshot({ channel: a }) }); a.accept({ bytes: snapshot({ channel: other }) });
  const signal = new AbortController().signal;
  expect(await a.binding({ signal })).not.toEqual(await other.binding({ signal }));
  expect(a.routes.send).not.toBe(other.routes.receive);
  const different = await RendezvousChannel.create({
    ...inputs,
    role: 'initiator',
    room: await rendezvousRoom({ code: '12345678', origin: 'https://relay.invalid' }),
  });
  onTestFinished(() => different.dispose()); expect(a.routes.send).not.toBe(different.routes.send);
});

it.each(['https://user:pass@relay.invalid', 'https://relay.invalid/path', 'https://relay.invalid/?query',
  'https://relay.invalid/#hash', 'file:///tmp/relay', 'ws://relay.invalid'])('origin %s is rejected before constructing a discovery channel', async origin => {
  await expect(rendezvousRoom({ code: 'ABCD-EFGH', origin })).rejects.toThrow('origin');
});

it('binding waits can be cancelled without publishing a partial result', async () => {
  const { a } = await pair(), stop = new AbortController(), reason = new Error('Cancel discovery');
  const pending = expect(a.binding({ signal: stop.signal })).rejects.toBe(reason); stop.abort(reason); await pending;
  expect(a.bound).toBe(false);
  await expect(a.send({ bytes: new Uint8Array() })).rejects.toThrow('not bound');
  await expect(a.receive({ signal: new AbortController().signal })).rejects.toThrow('not bound');
});

it('disposing wakes pending discovery and rejects subsequent journal operations', async () => {
  const { a } = await pair();
  const pending = expect(a.binding({ signal: new AbortController().signal })).rejects.toThrow('disposed');
  a.dispose(); a.dispose(); await pending;
  expect(() => a.snapshot()).toThrow('disposed'); expect(() => a.accept({ bytes: new Uint8Array() })).toThrow('disposed');
  await expect(a.send({ bytes: new Uint8Array() })).rejects.toThrow('disposed');
  await expect(a.receive({ signal: new AbortController().signal })).rejects.toThrow('disposed');
});

it.each(['cancel', 'dispose'] as const)('%s after owned digest preparation cannot publish a late binding', async action => {
  const { a, inputs } = await pair(), stop = new AbortController(), reason = new Error('Binding cancelled');
  const room = await rendezvousRoom({ code: 'ABCDEFGH', origin: 'https://relay.invalid' });
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let calls = 0;
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
    if (++calls === 3) {
      entered.resolve(); await release.promise;
    }
    return digest(algorithm, bytes);
  });
  let prepared = false;
  const preparing = RendezvousChannel.create({ ...inputs, room, role: 'responder' }).then(value => {
    prepared = true; return value;
  });
  await entered.promise; expect(prepared).toBe(false); release.resolve();
  const b = await preparing; onTestFinished(() => b.dispose());
  b.accept({ bytes: snapshot({ channel: a }) });
  const binding = b.binding({ signal: stop.signal });
  const rejected = action === 'cancel' ? expect(binding).rejects.toBe(reason) : expect(binding).rejects.toThrow('disposed');
  if (action === 'cancel') stop.abort(reason); else b.dispose();
  release.resolve(); await rejected;
});

it('returns independent binding copies without exposing the stored digest', async () => {
  const { a, b } = await pair(), signal = new AbortController().signal;
  b.accept({ bytes: snapshot({ channel: a }) }); a.accept({ bytes: snapshot({ channel: b }) });
  const first = await a.binding({ signal }), expected = first.slice();
  first.fill(0);
  expect(await a.binding({ signal })).toEqual(expected);
  expect(await b.binding({ signal })).toEqual(expected);
});

it('canonical origin spelling produces the same routes and binding on both peers', async () => {
  const { a, b } = await pair();
  expect(a.routes.send).toBe(b.routes.receive); expect(a.routes.receive).toBe(b.routes.send);
  b.accept({ bytes: snapshot({ channel: a }) }); a.accept({ bytes: snapshot({ channel: b }) });
  const signal = new AbortController().signal;
  expect(await a.binding({ signal })).toEqual(await b.binding({ signal }));
});

it('protocol envelope revisions do not change the historical room and route vectors', async () => {
  const room = await rendezvousRoom({ code: 'ABCD-EFGH', origin: 'https://relay.invalid' });
  expect(Array.from(room, byte => byte.toString(16).padStart(2, '0')).join('')).toBe('2b91fd687155fe75a6b60a303972d06b66778b5ad75bd4757de278cbd355bd7a');
  expect(await rendezvousRoute({ room, kind: 'offer', attempts: [] })).toBe('nPF6EK758iebsbd6PKl5nZQqhZnmo9b8S5JtzItLIp0');
});

it('actual serialized public bytes are copied and role-ordered in the authentication binding', async () => {
  const { a, inputs } = await pair(), room = await rendezvousRoom({ code: 'ABCDEFGH', origin: 'https://relay.invalid' });
  const changed = encodeDiscovery({ kind: 'offer', attemptI: inputs.attemptI, publicData: new Uint8Array([3]) });
  const b = await RendezvousChannel.create({ ...inputs, room, role: 'responder', offer: changed }); changed.fill(0);
  b.accept({ bytes: a.snapshot() }); a.accept({ bytes: b.snapshot() });
  const signal = new AbortController().signal;
  expect(await a.binding({ signal })).not.toEqual(await b.binding({ signal }));
  const swapped = await RendezvousChannel.create({ ...inputs, room, role: 'responder', offer: inputs.reply, reply: inputs.offer });
  swapped.accept({ bytes: a.snapshot() });
  expect(await swapped.binding({ signal })).not.toEqual(await a.binding({ signal })); b.dispose(); swapped.dispose();
});
