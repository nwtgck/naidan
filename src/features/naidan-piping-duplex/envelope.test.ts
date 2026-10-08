// @vitest-environment node
import { expect, it } from 'vitest';
import { encodeDiscovery, encodeHint, inspectDiscovery, journalBody, selectedChallenge } from './envelope';
import { encodeProtocolHeader } from './protocol-header';
import { JournalChannel } from './journal';
import { joinBytes } from './bytes';

const attemptI = new Uint8Array(32).fill(1), attemptR = new Uint8Array(32).fill(2);

it.each(['offer', 'reply'] as const)('%s has one exact header and a bounded little-endian public region', kind => {
  const bytes = encodeDiscovery({ kind, attemptI, attemptR, publicData: new Uint8Array(256).fill(7) });
  const at = kind === 'offer' ? 46 : 78;
  expect(bytes.slice(0, 13)).toEqual(new Uint8Array([0, 110, 97, 105, 100, 97, 110, 112, 100, 1, 0, 0, 128]));
  expect(bytes.slice(at, at + 2)).toEqual(new Uint8Array([0, 1])); expect(bytes.length).toBe(at + 258);
  const parsed = inspectDiscovery({ bytes }); expect(parsed).toMatchObject({ kind, publicData: new Uint8Array(256).fill(7) });
  bytes.fill(0); expect(parsed).toMatchObject({ publicData: new Uint8Array(256).fill(7) });
  expect(() => encodeDiscovery({ kind, attemptI, attemptR, publicData: new Uint8Array(257) })).toThrow();
  expect(() => encodeDiscovery({ kind, attemptI, attemptR, publicData: new Uint8Array(new SharedArrayBuffer(1)) })).toThrow();
});

it.each(['offer', 'reply'] as const)('%s rejects every incomplete body and trailing data', kind => {
  const bytes = encodeDiscovery({ kind, attemptI, attemptR, publicData: new Uint8Array([8]) });
  for (let size = 0; size < bytes.length; size++) expect(inspectDiscovery({ bytes: bytes.subarray(0, size) }).kind).toBe('observation');
  expect(inspectDiscovery({ bytes: joinBytes({ parts: [bytes, new Uint8Array([0])] }) }).kind).toBe('observation');
});

it('unknown versions expose only an answerable stable prefix, not public lengths', () => {
  const bytes = encodeDiscovery({ kind: 'offer', attemptI, publicData: new Uint8Array() });
  new DataView(bytes.buffer).setUint32(9, 0x80000002, true); bytes[46] = 255; bytes[47] = 255;
  expect(inspectDiscovery({ bytes })).toMatchObject({ kind: 'unsupported-offer', attemptI, version: 0x80000002 });
  for (const version of [0, 0x80000000]) {
    new DataView(bytes.buffer).setUint32(9, version, true);
    expect(inspectDiscovery({ bytes })).toMatchObject({ kind: 'observation', header: { kind: 'invalid-protocol-version' } });
  }
  new DataView(bytes.buffer).setUint32(9, 1, true);
  expect(inspectDiscovery({ bytes })).toMatchObject({ kind: 'unsupported-offer', version: 1 });
  bytes[0] = 1; expect(inspectDiscovery({ bytes })).toMatchObject({ kind: 'observation', header: { kind: 'wrong-protocol-magic' } });
});

it('hints are exact, carry the full version and never parse as answerable offers', () => {
  const bytes = encodeHint({ attemptI }); expect(bytes.length).toBe(46);
  expect(inspectDiscovery({ bytes })).toMatchObject({ kind: 'hint', attemptI, version: 0x80000001 });
  new DataView(bytes.buffer).setUint32(9, 0x80000002, true);
  expect(inspectDiscovery({ bytes })).toMatchObject({ kind: 'hint', version: 0x80000002 });
  expect(inspectDiscovery({ bytes: joinBytes({ parts: [bytes, new Uint8Array([0])] }) }).kind).toBe('observation');
});

it('selection and maximum journals have exact one-header finite bounds', async () => {
  const journal = new JournalChannel({ role: 'initiator', attemptI, attemptR }), challenge = new Uint8Array(32).fill(3);
  const prefix = joinBytes({ parts: [encodeProtocolHeader(), new Uint8Array([4]), challenge] });
  const select = joinBytes({ parts: [prefix, journal.snapshot()] }); expect(select.length).toBe(112);
  expect(selectedChallenge({ bytes: select, attemptI, attemptR })).toEqual(challenge);
  for (let size = 0; size < 112; size++) expect(selectedChallenge({ bytes: select.subarray(0, size), attemptI, attemptR })).toBeUndefined();
  for (let i = 0; i < 16; i++) await journal.send({ bytes: new Uint8Array(512) });
  const maximum = joinBytes({ parts: [prefix, journal.snapshot()] }); expect(maximum.length).toBe(8368); expect(journalBody({ bytes: maximum })).toHaveLength(8322);
  expect(journalBody({ bytes: joinBytes({ parts: [maximum, new Uint8Array([0])] }) })).toBeUndefined();
  expect(selectedChallenge({ bytes: maximum, attemptI, attemptR })).toBeUndefined(); journal.dispose();
});
