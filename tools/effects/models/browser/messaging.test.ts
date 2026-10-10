import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../../test-support/project-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';
import { runEffectTidy } from '../../maintenance/tidy.ts';
import { planEffectFix } from '../../fixes/plan.ts';
import { passiveMessageData } from './message-data.ts';
import { SCALAR, type Value } from '../../analysis/values.ts';

function inspect({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

function row({ source }: { source: string }) {
  const result = inspect({ source });
  expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
  const owner = result.owners.find(item => item.label === 'entry')!;
  expect(owner).toBeDefined();
  return result.solution.rows.get(owner.id)!.map(effect => printEffect({ effect })).sort();
}

const CROSS = ['messaging.crossorigin.send(*)'];

describe('window and broadcast transport policies', () => {
  it.each([
    'window.postMessage("x");',
    'window.postMessage("x", "/");',
    'parent.postMessage("x");',
    'window.parent.postMessage("x", "/");',
    'top!.postMessage("x", "/");',
    'window.opener.postMessage("x", "/");',
    'const target = window.parent; target.postMessage("x", "/");',
    'const send = window.parent.postMessage; send("x", "/");',
    'window["postMessage"]("x", "/");',
    'window.postMessage("x", {});',
    'window.postMessage("x", { targetOrigin: "/" });',
    'window.postMessage("x", ({ targetOrigin: "/" } satisfies WindowPostMessageOptions));',
    'window.postMessage("x", { targetOrigin: "/", transfer: [] });',
    'window.postMessage("x", "/", []);',
    'window.postMessage("x", void 0);',
    'window.postMessage("x", { targetOrigin: void 0 });',
    'const options = {}; window.postMessage("x", options);',
  ])('does not charge same-origin delivery itself: %s', statement => {
    expect(row({ source: `function entry() { ${statement} }` })).toEqual([]);
  });

  it.each([
    'window.postMessage("x", "*");',
    'window.parent.postMessage("x", "https://other.invalid");',
    'window.postMessage("x", { targetOrigin: "*" });',
    'window.parent.postMessage("x", { targetOrigin: "https://other.invalid" });',
    'window.postMessage("x", "https://naidan.invalid");',
    'window.postMessage("x", "null");',
    'window.postMessage("x", " / ");',
    'window.postMessage("x", { targetOrigin: "/", ...(Math.random() ? { targetOrigin: "*" } : {}) });',
    'let origin = "/"; origin = "*"; window.postMessage("x", origin);',
    'const options = { targetOrigin: "/" }; options.targetOrigin = "*"; window.postMessage("x", options);',
    'const options = { targetOrigin: "/" }; window.postMessage("x", options);',
  ])('retains cross-origin possibility without inferring a deployment origin: %s', statement => {
    // Duplicate explicit properties reported by TypeScript are not required here;
    // later spreads are valid and override the previous value at runtime.
    expect(row({ source: `function entry() { ${statement} }` })).toEqual(CROSS);
  });

  it('preserves TypeScript diagnostics for an unconditional duplicate property', () => {
    const result = inspect({ source: `function entry() { window.postMessage('x', { targetOrigin: '/', ...{ targetOrigin: '*' } }); }` });
    expect(result.diagnostics.some(item => item.code === 'typescript')).toBe(true);
    expect(result.modelDecisions.filter(item => item.rule === 'window.message.send').every(item => item.effects.some(effect => printEffect({ effect }) === 'messaging.crossorigin.send(*)'))).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it('uses the runtime dictionary overload for an object even when a cast says string', () => {
    expect(row({ source: `function entry() { const target = { toString() { localStorage.clear(); return '*'; } }; window.postMessage('x', target as unknown as string); }` })).toEqual([]);
  });

  it('uses the final explicit targetOrigin after a spread', () => {
    expect(row({ source: `function entry() { window.postMessage('x', { ...{ targetOrigin: '*' }, targetOrigin: '/' }); }` })).toEqual([]);
  });

  it('treats an unknown primitive target as external, not as script execution', () => {
    expect(row({ source: `function entry({ target }: { target: string }) { window.parent.postMessage({ value: 'x' }, target); }` })).toEqual(CROSS);
  });

  it('does not turn a narrow assertion into a browser-enforced origin restriction', () => {
    expect(row({ source: `function entry({ target }: { target: string }) { window.parent.postMessage('x', target as '/'); }` })).toEqual(CROSS);
  });

  it('retains a literal default through an immutable const alias', () => {
    expect(row({ source: `function entry() { const target: string = '/'; window.parent.postMessage('x', target); }` })).toEqual([]);
  });

  it('does not trust an identifier merely because it is spelled undefined', () => {
    expect(row({ source: `function entry({ undefined }: { undefined: string }) { window.parent.postMessage('x', undefined); }` })).toEqual(CROSS);
  });

  it('keeps mixed origin alternatives conservative', () => {
    expect(row({ source: `function entry({ yes }: { yes: boolean }) { parent.postMessage('x', yes ? '/' : '*'); }` })).toEqual(CROSS);
  });

  it('does not reuse an earlier local origin after object copies', () => {
    expect(row({ source: `function entry() { const options: { targetOrigin: string } = { targetOrigin: '/' }; options.targetOrigin = '*'; const copied = { ...options }; parent.postMessage('x', copied); }` })).toEqual(CROSS);
  });

  it('supports a typed Window contract without assuming the target window origin', () => {
    expect(row({ source: `function entry({ target }: { target: Window }) { target.postMessage('x', '*'); }` })).toEqual(CROSS);
  });

  it('does not classify a local postMessage method as a Window operation', () => {
    expect(row({ source: `function entry() { const window = { postMessage(message: string, target: string) { localStorage.clear(); return message + target; } }; window.postMessage('x', '/'); }` })).toEqual(['localstorage.write(*)']);
  });

  it('does not classify a shadowed BroadcastChannel constructor as a native channel', () => {
    const result = inspect({ source: `function entry() { const BroadcastChannel = function () { localStorage.clear(); }; new BroadcastChannel(); }` });
    // TypeScript rejects this constructor shape, but the model must never claim it.
    expect(result.modelDecisions.some(item => item.rule === 'broadcast-channel.construct')).toBe(false);
  });

  it.each([
    `const channel = new BroadcastChannel('sync'); channel.postMessage('x'); channel.close();`,
    `const channel = new BroadcastChannel('sync'); channel.postMessage({ value: 'x', nested: { count: 2 } });`,
    `const channel: BroadcastChannel = new BroadcastChannel('sync'); const alias = channel; alias.postMessage({ value: 'x' });`,
    `const channel = new BroadcastChannel('sync'); const send = channel.postMessage; send('x');`,
    `const channel = new BroadcastChannel('sync'); void channel.name;`,
  ])('records internal broadcast as intentional-none: %s', statement => {
    const source = `function entry() { ${statement} }`;
    expect(row({ source })).toEqual([]);
    const result = inspect({ source });
    expect(result.modelDecisions.some(item => item.rule.startsWith('broadcast-channel.') && item.disposition === 'intentional-none')).toBe(true);
  });

  it('does not erase storage writes used by same-origin synchronization', () => {
    expect(row({ source: `function entry() { const channel = new BroadcastChannel('sync'); localStorage.setItem('event', 'x'); channel.postMessage('x'); }` })).toEqual(['localstorage.write(*)']);
  });

  it('preserves payload and target expression evaluation even for same-origin delivery', () => {
    expect(row({ source: `function entry() { window.postMessage((localStorage.clear(), 'x'), void fetch('/log')); }` })).toEqual(['localstorage.write(*)', 'network.http(*)']);
  });

  it('keeps the Blob acquisition separate from an internal send', () => {
    expect(row({ source: `async function entry() { const response = await fetch('/blob'); const blob = await response.blob(); const channel = new BroadcastChannel('sync'); channel.postMessage(blob); }` })).toEqual(['network.http(*)']);
  });

  it('does not execute an ignored extra options callback', () => {
    expect(row({ source: `function entry() { window.postMessage('x', { targetOrigin: '/', extra: () => localStorage.clear() } as WindowPostMessageOptions); }` })).toEqual([]);
  });
});

describe('serialization and transport identity are not waived by internal delivery', () => {
  it.each([
    `window.postMessage({ get secret() { localStorage.clear(); return 'x'; } }, '/');`,
    `const original = { x: 'x', get secret() { localStorage.clear(); return 'x'; } }; const view: { x: string } = original; window.postMessage(view, '/');`,
    `window.postMessage(() => localStorage.clear(), '/');`,
    `const original = { x: 'x', run: () => localStorage.clear() }; const view: { x: string } = original; window.postMessage(view, '/');`,
    `window.postMessage(Promise.resolve('x'), '/');`,
    `window.postMessage(['x'], '/');`,
    `const channel = new BroadcastChannel('sync'); channel.postMessage({ get x() { localStorage.clear(); return 'x'; } });`,
    `const channel = new BroadcastChannel('sync'); channel.postMessage(() => localStorage.clear());`,
    `const source = { toString() { localStorage.clear(); return 'sync'; } }; new BroadcastChannel(source as unknown as string);`,
    `const target = { toString() { localStorage.clear(); return '/'; } }; window.postMessage('x', target as unknown as string, []);`,
    `window.postMessage('x', { get targetOrigin() { localStorage.clear(); return '/'; } });`,
    `const original = { x: 1, get targetOrigin() { localStorage.clear(); return '/'; } }; const options: {} = original; window.postMessage('x', options);`,
    `const transfer: Transferable[] = []; window.postMessage('x', '/', transfer);`,
    `const transfer: Transferable[] = []; window.postMessage('x', { targetOrigin: '/', transfer });`,
    `const options = { targetOrigin: '/', transfer: [] }; window.postMessage('x', options);`,
    `window.postMessage('x', { targetOrigin: '/', transfer: null as unknown as Transferable[] });`,
    `const channel = new BroadcastChannel('sync'); channel.onmessage = () => localStorage.clear();`,
    `self.postMessage('x', '*');`,
    `globalThis.postMessage('x', '*');`,
    `postMessage('x', '*');`,
  ])('retains a blocking diagnostic and refuses fixes: %s', statement => {
    const result = inspect({ source: `function entry() { ${statement} }` });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported' || item.code === 'boundary')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it.each([
    'message: { value: string }',
    'message: Record<string, string>',
    'message: string[]',
    'message: unknown',
  ])('does not treat an open input contract as a complete cloned shape: %s', parameter => {
    const result = inspect({ source: `function entry({ message }: { ${parameter} }) { window.postMessage(message, '/'); }` });
    expect(result.diagnostics.some(item => item.message.includes('Message serialization'))).toBe(true);
  });

  it('refuses mutable options from an open parameter', () => {
    const result = inspect({ source: `function entry({ options }: { options: WindowPostMessageOptions }) { window.postMessage('x', options); }` });
    expect(result.diagnostics.some(item => item.message.includes('closed dictionary'))).toBe(true);
  });

  it('does not disguise unknown Window-message data with an unsafe effect boundary', () => {
    const result = inspect({
      source: `/** @effects [] */
/** @effectsUNSAFE {"effects":["messaging.crossorigin.send(*)"],"reason":"Only a reviewed outward exception."} */
function entry({ message }: { message: unknown }) { parent.postMessage(message, '*'); }`,
    });
    expect(result.diagnostics.some(item => item.message.includes('Message serialization'))).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it.each([
    `String(undefined);`,
    `window.postMessage('x', undefined as unknown as string, []);`,
    `window.postMessage('x', { targetOrigin: undefined as unknown as string });`,
  ])('does not erase a shadowed undefined conversion hook: %s', statement => {
    const result = inspect({ source: `function entry() { const undefined = { /** @effects ["localstorage.write(*)"] */ toString() { localStorage.clear(); return '*'; } }; ${statement} }` });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(() => planEffectFix({ analysis: result })).toThrow();
  });

  it('does not make native MessagePort delivery into same-origin Window delivery', () => {
    const result = inspect({ source: `function entry() { const channel = new MessageChannel(); channel.port1.postMessage('x'); }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(result.modelDecisions.some(item => item.rule === 'window.message.send')).toBe(false);
  });

  it('does not accept an extended native channel interface as a trusted platform type', () => {
    const result = inspect({ source: `interface BroadcastChannel { extra: string; } function entry({ channel }: { channel: BroadcastChannel }) { channel.postMessage('x'); }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported' || item.code === 'boundary')).toBe(true);
  });
});

describe('message contracts share the ordinary maintenance pipeline', () => {
  it('widens the helper and caller together, then repeats without changes', () => {
    const fixture = createFixture({
      files: {
        'send.ts': `export function send() { window.parent.postMessage({ value: 'x' }, '*'); }`,
        'main.ts': `import { send } from './send'; export function entry() { send(); }`,
      },
      entries: ['main.ts'],
    });
    try {
      const fixed = fixture.fix();
      expect(fixed.analysis.diagnostics).toEqual([]);
      expect(fixed.changedFiles).toHaveLength(2);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('messaging.crossorigin.send(*)');
      expect(fixture.fix().changedFiles).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it('tidies a stale external upper bound only when selected delivery is internal', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `/** @effects ["messaging.crossorigin.send(*)"] */
export function entry() { window.parent.postMessage({ value: 'x' }, '/'); }`,
      },
      entries: ['main.ts'],
    });
    try {
      expect(fixture.check().diagnostics).toEqual([]);
      const tidied = runEffectTidy({ root: fixture.root, config: fixture.config, write: 'write', files: ['main.ts'], inputSnapshots: new Map() });
      expect(tidied.analysis.diagnostics).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('@effects []');
      expect(fixture.fix().changedFiles).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it('exposes the local policy reason without claiming the payload guard passed', () => {
    const result = inspect({ source: `function entry({ payload }: { payload: unknown }) { window.postMessage(payload, '/'); }` });
    const decisions = result.modelDecisions.filter(item => item.rule === 'window.message.send');
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every(item => item.effects.length === 0 && item.reason.includes('Serialization'))).toBe(true);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });
});

describe('closed message-data guard', () => {
  it('rejects unknown additional keys even when the visible index is scalar', () => {
    expect(passiveMessageData({ value: { kind: 'record', fields: new Map(), shape: 'open', reflected: undefined, indexValue: SCALAR }, seen: new Set() })).toBe(false);
  });

  it('rejects unsupported cycles without recursing forever', () => {
    const fields = new Map<string, { value: Value, access: 'writable' }>();
    const value: Value = { kind: 'record', fields, shape: 'closed', reflected: undefined, indexValue: undefined };
    fields.set('self', { value, access: 'writable' });
    expect(passiveMessageData({ value, seen: new Set() })).toBe(false);
  });

  it('does not confuse sharing of a passive object with a recursion cycle', () => {
    const child: Value = { kind: 'record', fields: new Map([['x', { value: SCALAR, access: 'writable' }]]), shape: 'closed', reflected: undefined, indexValue: undefined };
    const value: Value = { kind: 'record', fields: new Map([['a', { value: child, access: 'writable' }], ['b', { value: child, access: 'writable' }]]), shape: 'closed', reflected: undefined, indexValue: undefined };
    expect(passiveMessageData({ value, seen: new Set() })).toBe(true);
  });
});
