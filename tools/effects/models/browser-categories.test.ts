import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';

function inspect({ body }: { body: string }) {
  const fixture = createFixture({ files: { 'main.ts': `export async function inspect() { ${body} }` }, entries: ['main.ts'] });
  try {
    const analysis = fixture.check();
    const owner = analysis.owners.find(item => item.label === 'inspect')!;
    return {
      diagnostics: analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds'),
      effects: (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect })),
    };
  } finally {
    fixture.dispose();
  }
}

describe('browser operation categories distinguish data inspection from I/O', () => {
  it.each([
    { body: "indexedDB.cmp('a', 'b');", effects: [] },
    { body: 'indexedDB.cmp(1, 2);', effects: [] },
    { body: 'await indexedDB.databases();', effects: ['indexeddb.read(*)'] },
    { body: "indexedDB.open('models');", effects: ['indexeddb.read(*)', 'indexeddb.write(*)'] },
    { body: "indexedDB.deleteDatabase('models');", effects: ['indexeddb.write(*)'] },
    { body: 'new XMLHttpRequest();', effects: [] },
    { body: "const request = new XMLHttpRequest(); request.getResponseHeader('content-type');", effects: [] },
    { body: 'const request = new XMLHttpRequest(); request.getAllResponseHeaders();', effects: [] },
    { body: "const request = new XMLHttpRequest(); request.setRequestHeader('x-example', 'yes');", effects: [] },
    { body: "const request = new XMLHttpRequest(); request.overrideMimeType('text/plain');", effects: [] },
    { body: 'const request = new XMLHttpRequest(); request.send();', effects: ['network.http(*)'] },
    { body: 'const request = new XMLHttpRequest(); request.abort();', effects: ['network.http(*)'] },
    // open() can terminate an earlier request. Do not reconstruct object lifetime here.
    { body: "const request = new XMLHttpRequest(); request.open('GET', '/');", effects: ['network.http(*)'] },
    { body: "new WebSocket('wss://example.invalid/');", effects: ['network.websocket(*)'] },
    { body: "new EventSource('/events');", effects: ['network.http(*)'] },
    { body: 'navigator.storage.persisted();', effects: [] },
    { body: 'navigator.storage.estimate();', effects: [] },
    { body: 'navigator.storage.persist();', effects: [] },
    { body: "await caches.has('models');", effects: ['cachestorage.read(*)'] },
    { body: "await caches.open('models');", effects: ['cachestorage.write(*)'] },
    { body: "await caches.delete('models');", effects: ['cachestorage.write(*)'] },
    { body: "const cache = await caches.open('models'); await cache.add('/model');", effects: ['cachestorage.write(*)', 'network.http(*)'] },
  ])('$body -> $effects', ({ body, effects }) => {
    const result = inspect({ body });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(effects);
  });

  it.each([
    "indexedDB.cmp({ valueOf() { localStorage.clear(); return 1; } }, 2);",
    "const request = new XMLHttpRequest(); request.getResponseHeader({ toString() { localStorage.clear(); return 'x'; } } as unknown as string);",
    "const request = new XMLHttpRequest(); request.setRequestHeader('x', { toString() { localStorage.clear(); return 'y'; } } as unknown as string);",
  ])('does not certify unmodeled argument conversion: %s', body => {
    expect(inspect({ body }).diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not turn all methods on a familiar receiver into a generic network effect', () => {
    const result = inspect({ body: 'const request = new XMLHttpRequest(); request.toString();' });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('still analyzes explicitly invoked arguments even for an effect-free operation', () => {
    const result = inspect({ body: "const request = new XMLHttpRequest(); request.getResponseHeader((() => { localStorage.clear(); return 'x'; })());" });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['localstorage.write(*)']);
  });
});

describe('metadata result use and declaration identity', () => {
  it('allows inspecting usage and quota without claiming the result is a closed object', () => {
    const result = inspect({ body: 'const result = await navigator.storage.estimate(); const usage = result.usage ?? 0; const quota = result.quota ?? 0; return quota - usage;' });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it('does not certify enumeration of arbitrary metadata extensions', () => {
    expect(inspect({ body: 'const result = await navigator.storage.estimate(); const copy = { ...result };' }).diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not treat local indexedDB-shaped objects as browser primitives', () => {
    const result = inspect({ body: "const indexedDB = { cmp: () => { localStorage.clear(); return 0; } }; indexedDB.cmp();" });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['localstorage.write(*)']);
  });

  it('retains classification through a const alias of the browser factory', () => {
    const result = inspect({ body: "const factory = indexedDB; factory.cmp('a', 'b'); await factory.databases();" });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['indexeddb.read(*)']);
  });

  it('does not use the database write family as a fallback for unknown members', () => {
    const result = inspect({ body: 'indexedDB.toString();' });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not turn a local globalThis binding into a native root', () => {
    const result = inspect({ body: "const globalThis = { indexedDB: { cmp: () => { localStorage.clear(); return 0; } } }; globalThis.indexedDB.cmp();" });
    expect(result.diagnostics).toEqual([]);
    expect(result.effects).toEqual(['localstorage.write(*)']);
  });

  it('supports fully qualified globals without changing operation categories', () => {
    const request = inspect({ body: 'const request = new window.XMLHttpRequest(); request.getAllResponseHeaders();' });
    expect(request.diagnostics).toEqual([]);
    expect(request.effects).toEqual([]);
    const database = inspect({ body: 'await globalThis.indexedDB.databases();' });
    expect(database.diagnostics).toEqual([]);
    expect(database.effects).toEqual(['indexeddb.read(*)']);
  });
});
