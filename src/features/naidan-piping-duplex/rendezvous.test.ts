// @vitest-environment node
import { expect, onTestFinished, it, vi } from 'vitest';
import { RendezvousChannel, createNaidanPipingCode, normalizeRendezvousCode } from '@/features/naidan-piping-duplex/rendezvous';
import { useOfflineScope } from '@/features/naidan-piping-duplex/test-support';

useOfflineScope();
async function pair() {
  const a = await RendezvousChannel.create({ role: 'initiator', code: 'abcd-efgh', origin: 'https://relay.invalid/' });
  const b = await RendezvousChannel.create({ role: 'responder', code: 'ABCDEFGH', origin: 'https://relay.invalid' });
  onTestFinished(() => {
    a.dispose(); b.dispose();
  });
  return { a, b };
}
function snapshot({ channel }: { channel: RendezvousChannel }): Uint8Array {
  const bytes = channel.snapshot(); if (!bytes) throw new Error('Missing advertisement'); return bytes;
}

it('normalization handles only explicit ASCII spelling and never approximates ambiguous characters', () => {
  expect(normalizeRendezvousCode({ code: 'abcd-efgh' })).toBe('ABCDEFGH');
  for (const code of ['ABCD-EFGI', 'ABCD-EFGO', 'ABCD-EFGL', 'ABCD-EFGU', ' ABCD-EFGH', 'ＡBCD-EFGH', 'AB-CD-EFGH', 'ABCDEFG', 'ABCDEFGHI'])
    expect(() => normalizeRendezvousCode({ code })).toThrow();
  for (let index = 0; index < 100; index++) expect(createNaidanPipingCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
});

it('independent discovery produces reciprocal routes and a matching binding without sharing attempts', async () => {
  const { a, b } = await pair(); expect(b.snapshot()).toBeUndefined();
  expect(a.routes.send).toBe(b.routes.receive); expect(a.routes.receive).toBe(b.routes.send);
  expect(a.routes.send).not.toBe(a.routes.receive); expect(Object.isFrozen(a.routes)).toBe(true);
  b.accept({ bytes: snapshot({ channel: a }) }); a.accept({ bytes: snapshot({ channel: b }) });
  const signal = new AbortController().signal;
  expect(await a.binding({ signal })).toEqual(await b.binding({ signal }));
  await a.send({ bytes: new Uint8Array([7, 8]) }); b.accept({ bytes: snapshot({ channel: a }) });
  expect(await b.receive({ signal })).toEqual(new Uint8Array([7, 8]));
});

it('delayed initial and unrelated initiator attempts cannot replace a selected pair or journal', async () => {
  const { a, b } = await pair(), initial = snapshot({ channel: a });
  b.accept({ bytes: initial }); a.accept({ bytes: snapshot({ channel: b }) });
  const binding = await b.binding({ signal: new AbortController().signal });
  await b.send({ bytes: new Uint8Array([19]) }); const selected = snapshot({ channel: b });
  b.accept({ bytes: initial }); expect(snapshot({ channel: b })).toEqual(selected);
  const other = await pair(); b.accept({ bytes: snapshot({ channel: other.a }) });
  expect(await b.binding({ signal: new AbortController().signal })).toEqual(binding);
  expect(snapshot({ channel: b })).toEqual(selected);
});

it('a malformed first response cannot lock the initiator to its attempt', async () => {
  const { a, b } = await pair(); b.accept({ bytes: snapshot({ channel: a }) });
  const bad = snapshot({ channel: b }); bad[66] = 1;
  expect(() => a.accept({ bytes: bad })).toThrow(); expect(a.bound).toBe(false);
  a.accept({ bytes: snapshot({ channel: b }) }); expect(a.bound).toBe(true);
});

it('a response from a previous initiator attempt cannot bind a new attempt', async () => {
  const first = await pair(), second = await pair(); first.b.accept({ bytes: snapshot({ channel: first.a }) });
  second.a.accept({ bytes: snapshot({ channel: first.b }) }); expect(second.a.bound).toBe(false);
});

it('room and canonical origin separate routing and cryptographic bindings', async () => {
  const { a } = await pair();
  const other = await RendezvousChannel.create({ role: 'responder', code: 'ABCDEFGH', origin: 'https://other.invalid' });
  onTestFinished(() => other.dispose());
  other.accept({ bytes: snapshot({ channel: a }) }); a.accept({ bytes: snapshot({ channel: other }) });
  const signal = new AbortController().signal;
  expect(await a.binding({ signal })).not.toEqual(await other.binding({ signal }));
  expect(a.routes.send).not.toBe(other.routes.receive);
  const different = await RendezvousChannel.create({ role: 'initiator', code: '12345678', origin: 'https://relay.invalid' });
  onTestFinished(() => different.dispose()); expect(a.routes.send).not.toBe(different.routes.send);
});

it.each(['https://user:pass@relay.invalid', 'https://relay.invalid/path', 'https://relay.invalid/?query',
  'https://relay.invalid/#hash', 'file:///tmp/relay', 'ws://relay.invalid'])('origin %s is rejected before constructing a discovery channel', async origin => {
  await expect(RendezvousChannel.create({ role: 'initiator', code: 'ABCD-EFGH', origin })).rejects.toThrow('origin');
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

it.each(['cancel', 'dispose'] as const)('%s during the binding digest cannot publish its eventual result', async action => {
  const { a, b } = await pair(), stop = new AbortController(), reason = new Error('Binding cancelled');
  const release = Promise.withResolvers<void>();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const entered = Promise.withResolvers<void>();
  vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, bytes) => {
    entered.resolve(); await release.promise; return digest(algorithm, bytes);
  });
  b.accept({ bytes: snapshot({ channel: a }) });
  await entered.promise;
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
  const a = await RendezvousChannel.create({ role: 'initiator', code: 'abcd-efgh', origin: 'https://RELAY.invalid:443/' });
  const b = await RendezvousChannel.create({ role: 'responder', code: 'ABCDEFGH', origin: 'https://relay.invalid' });
  onTestFinished(() => {
    a.dispose(); b.dispose();
  });
  expect(a.routes.send).toBe(b.routes.receive); expect(a.routes.receive).toBe(b.routes.send);
  b.accept({ bytes: snapshot({ channel: a }) }); a.accept({ bytes: snapshot({ channel: b }) });
  const signal = new AbortController().signal;
  expect(await a.binding({ signal })).toEqual(await b.binding({ signal }));
});
