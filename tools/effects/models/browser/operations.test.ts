import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_OPERATIONS } from './operations.ts';
import { indexOperations, type OperationRule } from '../operation.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from '../registry.ts';
import { createFixture } from '../../test-support/project-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';

function inspect({ body, before }: { body: string, before: string }) {
  const fixture = createFixture({ files: { 'main.ts': `${before}\nexport async function inspect() { ${body} }` }, entries: ['main.ts'] });
  try {
    const analysis = fixture.check();
    const owner = analysis.owners.find(item => item.label === 'inspect')!;
    return {
      diagnostics: analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds'),
      effects: (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect })),
      decisions: analysis.modelDecisions.filter(item => item.owner === owner.id),
    };
  } finally {
    fixture.dispose();
  }
}

const noneRule = (): OperationRule => ({
  id: 'test',
  definedIn: import.meta.url,
  access: 'call',
  targets: ['test.op'],
  policy: { kind: 'intentional-none', reason: 'An explicit policy used only in this test.' },
  evaluate: () => ({ kind: 'scalar', keys: undefined, truthiness: 'unknown' }),
});

describe('primitive operation definitions are the executable audit source', () => {
  it('indexes every target once, with a real definition file and a nonempty rationale', () => {
    const index = indexOperations({ rules: BROWSER_OPERATIONS });
    expect(index.size).toBe(BROWSER_OPERATIONS.reduce((count, rule) => count + rule.targets.length, 0));
    for (const rule of BROWSER_OPERATIONS) {
      expect(fs.existsSync(fileURLToPath(rule.definedIn))).toBe(true);
      expect(rule.policy.reason.length).toBeGreaterThan(20);
      const names = (() => {
        switch (rule.policy.kind) {
        case 'intentional-none': return [];
        case 'tracked': return rule.policy.effects;
        case 'conditional': return rule.policy.possibleEffects;
        default: { const exhaustive: never = rule.policy; throw new Error(String(exhaustive)); }
        }
      })();
      for (const name of names) expect(DEFAULT_EFFECT_DEFINITIONS.some(definition => definition.name === name)).toBe(true);
    }
  });

  it('rejects duplicate matching targets instead of depending on rule order', () => {
    expect(() => indexOperations({ rules: [noneRule(), { ...noneRule(), id: 'other' }] })).toThrow('Duplicate');
  });

  it('rejects duplicate identities even if targets differ', () => {
    expect(() => indexOperations({ rules: [noneRule(), { ...noneRule(), targets: ['other'] }] })).toThrow('Duplicate');
  });

  it('does not allow silent empty tracked effects', () => {
    expect(() => indexOperations({ rules: [{ ...noneRule(), policy: { kind: 'tracked', effects: [], reason: 'Missing explicit none.' } }] })).toThrow('intentional-none');
  });

  it('requires a reason even for intentionally untracked operations', () => {
    expect(() => indexOperations({ rules: [{ ...noneRule(), policy: { kind: 'intentional-none', reason: '  ' } }] })).toThrow('rationale');
  });

  it('requires an explicit possible effect set for conditional policies', () => {
    expect(() => indexOperations({ rules: [{ ...noneRule(), policy: { kind: 'conditional', possibleEffects: [], select: () => [], reason: 'Not enough.' } }] })).toThrow('envelope');
  });

  it('distinguishes reading, writing and calling the same surface', () => {
    const index = indexOperations({ rules: [noneRule(), { ...noneRule(), id: 'read', access: 'read' }] });
    expect(index.get('call:test.op')?.id).toBe('test');
    expect(index.get('read:test.op')?.id).toBe('read');
    expect(index.has('write:test.op')).toBe(false);
  });
});

describe('actual syntax reaches the audited primitive entry points', () => {
  it.each([
    { body: 'await navigator.storage.persisted();', effects: [], rule: 'storage-manager.persisted', disposition: 'intentional-none' },
    { body: 'await globalThis.navigator.storage.persist();', effects: [], rule: 'storage-manager.persist', disposition: 'intentional-none' },
    { body: 'const storage = window.navigator.storage; await storage.estimate();', effects: [], rule: 'storage-manager.estimate', disposition: 'intentional-none' },
    { body: 'const { persisted } = navigator.storage; await persisted();', effects: [], rule: 'storage-manager.persisted', disposition: 'intentional-none' },
    { body: 'await navigator.storage.getDirectory();', effects: ['opfs.read(*)'], rule: 'storage-manager.get-directory', disposition: 'tracked' },
    { body: "await fetch('/data');", effects: ['network.http(*)'], rule: 'fetch.request', disposition: 'tracked' },
    { body: "const request = globalThis.fetch; await request('/data');", effects: ['network.http(*)'], rule: 'fetch.request', disposition: 'tracked' },
    { body: "navigator.sendBeacon('/beacon');", effects: ['network.http(*)'], rule: 'beacon.send', disposition: 'tracked' },
    { body: 'const s = localStorage; s.clear();', effects: ['localstorage.write(*)'], rule: 'localstorage.write-method', disposition: 'tracked' },
    { body: "sessionStorage.setItem('x', '1');", effects: ['sessionstorage.write(*)'], rule: 'sessionstorage.write-method', disposition: 'tracked' },
    { body: 'const s = localStorage; return s.length;', effects: ['localstorage.read(*)'], rule: 'localstorage.length', disposition: 'tracked' },
    { body: 'const { cookie } = document;', effects: ['cookie.read(*)'], rule: 'cookie.read', disposition: 'tracked' },
    { body: 'const { length } = localStorage;', effects: ['localstorage.read(*)'], rule: 'localstorage.length', disposition: 'tracked' },
    { body: 'document.cookie;', effects: ['cookie.read(*)'], rule: 'cookie.read', disposition: 'tracked' },
    { body: "document.cookie = 'x=1';", effects: ['cookie.write(*)'], rule: 'cookie.write', disposition: 'tracked' },
    { body: "sessionStorage['item'] = 'value';", effects: ['sessionstorage.write(*)'], rule: 'sessionstorage.property-write', disposition: 'tracked' },
    { body: "const root = await navigator.storage.getDirectory(); const file = await root.getFileHandle('x'); const w = await file.createWritable(); await w.write('text');", effects: ['opfs.read(*)', 'opfs.write(*)'], rule: 'opfs.writer.mutate', disposition: 'tracked' },
    { body: "const root = await navigator.storage.getDirectory(); await root.getDirectoryHandle('x', { create: false });", effects: ['opfs.read(*)'], rule: 'opfs.directory.getDirectoryHandle', disposition: 'conditional' },
    { body: "const root = await navigator.storage.getDirectory(); await root.getFileHandle('x', { create: true });", effects: ['opfs.read(*)', 'opfs.write(*)'], rule: 'opfs.directory.getFileHandle', disposition: 'conditional' },
    { body: "const c = await caches.open('x'); await c.add('/data');", effects: ['cachestorage.write(*)', 'network.http(*)'], rule: 'cache-storage.fetch-and-store', disposition: 'tracked' },
    { body: 'new XMLHttpRequest();', effects: [], rule: 'xhr.construct', disposition: 'intentional-none' },
    { body: "const request = new XMLHttpRequest(); request.open('GET','/'); request.send();", effects: ['network.http(*)'], rule: 'xhr.send', disposition: 'tracked' },
    { body: "new WebSocket('wss://example.invalid');", effects: ['network.websocket(*)'], rule: 'WebSocket.connect', disposition: 'tracked' },
    { body: "const pc = new RTCPeerConnection(); const channel = pc.createDataChannel('x'); channel.send('hello');", effects: ['network.webrtc(*)'], rule: 'webrtc.data-channel', disposition: 'tracked' },
    { body: "const response = await fetch('/'); await response.text();", effects: ['network.http(*)'], rule: 'response.text', disposition: 'intentional-none' },
  ])('$rule: $body', ({ body, effects, rule, disposition }) => {
    const result = inspect({ body, before: '' });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(effects);
    const decision = result.decisions.find(item => item.rule === rule);
    expect(decision?.disposition).toBe(disposition);
    expect(decision?.definitionFile).toContain('/tools/effects/models/browser/');
    expect(decision?.reason.length).toBeGreaterThan(20);
  });

  it.each([
    'navigator.storage.toString();',
    "const cache = await caches.open('x'); cache.toString();",
    "const socket = new WebSocket('wss://example.invalid'); socket.toString();",
  ])('does not fall back to none or a whole-receiver effect: %s', body => {
    const result = inspect({ body, before: '' });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(result.decisions.some(item => item.operation.endsWith('.toString'))).toBe(false);
  });

  it.each([
    "const navigator = { storage: { persisted() { localStorage.clear(); return true; } } }; navigator.storage.persisted();",
    "const fetch = () => localStorage.clear(); fetch();",
    "const file = { write() { sessionStorage.clear(); } }; file.write();",
  ])('does not mistake a familiar spelling for platform identity: %s', body => {
    const result = inspect({ body, before: '' });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual([body.includes('sessionStorage') ? 'sessionstorage.write(*)' : 'localstorage.write(*)']);
    expect(result.decisions.some(item => item.rule.startsWith('storage-manager.') || item.rule === 'fetch.request')).toBe(false);
  });

  it('does not hide the evaluated receiver of an intentional-none primitive', () => {
    const result = inspect({ before: '', body: 'const storage = (localStorage.clear(), navigator.storage); await storage.persisted();' });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['localstorage.write(*)']);
    expect(result.decisions.some(item => item.rule === 'storage-manager.persisted')).toBe(true);
  });

  it('does not hide a no-argument method\'s extra argument evaluation, or call the callback merely passed there', () => {
    // TypeScript correctly rejects extra arguments to this no-arg Web IDL method.
    // The effect pass must still see explicit evaluation; no fake successful fix.
    const result = inspect({ before: '', body: "navigator.storage.persisted(localStorage.clear(), () => sessionStorage.clear());" });
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(true);
    expect(result.effects).toEqual(['localstorage.write(*)']);
    expect(result.decisions.some(item => item.rule === 'storage-manager.persisted')).toBe(true);
  });

  it('keeps unsupported coercion visible even when the selected policy says none', () => {
    const result = inspect({ before: '', body: "new XMLHttpRequest().getResponseHeader({ toString() { localStorage.clear(); return 'x'; } } as unknown as string);" });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(result.decisions.some(item => item.rule === 'xhr.headers' && item.disposition === 'intentional-none')).toBe(true);
  });

  it('retains both filesystem candidates for a bare handle type rather than inventing provenance', () => {
    const result = inspect({ before: 'export async function read(file: FileSystemFileHandle) { await file.getFile(); }', body: '' });
    expect(result.diagnostics).toEqual([]);
    const fixture = createFixture({ files: { 'main.ts': 'export async function read(file: FileSystemFileHandle) { await file.getFile(); }' }, entries: ['main.ts'] });
    try {
      const decision = fixture.check().modelDecisions.find(item => item.rule === 'FileSystemFileHandle.get-file')!;
      expect(decision.effects.map(effect => printEffect({ effect })).sort()).toEqual(['hostfs.read(*)', 'opfs.read(*)']);
    } finally {
      fixture.dispose();
    }
  });
});
