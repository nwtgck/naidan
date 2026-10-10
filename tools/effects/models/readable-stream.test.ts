import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';

function inspect({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

const startupCases = [
  {
    name: 'synchronous start',
    body: 'new ReadableStream({ /** @effects ["localstorage.write(*)"] */ start() { localStorage.clear(); } });',
    expected: ['localstorage.write(*)'],
  },
  {
    name: 'scheduled pull',
    body: 'new ReadableStream({ /** @effects ["localstorage.write(*)"] */ pull() { localStorage.clear(); } });',
    expected: ['localstorage.write(*)'],
  },
  {
    name: 'asynchronous start body',
    body: 'new ReadableStream({ /** @effects ["localstorage.write(*)"] */ async start() { await Promise.resolve(); localStorage.clear(); } });',
    expected: ['localstorage.write(*)'],
  },
  {
    name: 'literal zero high water mark',
    body: 'new ReadableStream({ /** @effects ["localstorage.write(*)"] */ start() { localStorage.clear(); }, /** @effects ["sessionstorage.write(*)"] */ pull() { sessionStorage.clear(); } }, { highWaterMark: 0 });',
    expected: ['localstorage.write(*)'],
  },
  {
    name: 'unproved strategy retains the pull upper bound',
    body: 'const strategy = { highWaterMark: 0 }; new ReadableStream({ /** @effects ["localstorage.write(*)"] */ pull() { localStorage.clear(); } }, strategy);',
    expected: ['localstorage.write(*)'],
  },
  {
    name: 'closed start retains a conservative pull upper bound',
    body: 'new ReadableStream({ /** @effects [] */ start(controller) { controller.close(); }, /** @effects ["localstorage.write(*)"] */ pull() { localStorage.clear(); } });',
    expected: ['localstorage.write(*)'],
  },
  {
    name: 'cancellation is separate from startup',
    body: 'new ReadableStream({ /** @effects ["localstorage.write(*)"] */ cancel() { localStorage.clear(); } });',
    expected: [],
  },
];

describe('partial native ReadableStream startup effects', () => {
  it.each(startupCases)('propagates $name and keeps the unsupported boundary', ({ body, expected }) => {
    const result = inspect({
      source: `\
export {};
/** @effects [] */
function entry() { ${body} }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript' || item.code === 'syntax')).toEqual([]);
    const owner = result.owners.find(item => item.label === 'entry' && item.role === 'implementation')!;
    expect((result.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }))).toEqual(expected);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('startup callbacks'))).toBe(true);
    if (expected.length > 0) expect(result.diagnostics.some(item => item.code === 'exceeds' && item.start === owner.location.start)).toBe(true);
  });

  it('forwards captured source callbacks through the constructor to its caller', () => {
    const result = inspect({
      source: `\
export {};
/** @effects ["call(arg0.read)"] */
function createStream({ read }: { read: () => void }) {
  return new ReadableStream({ /** @effects ["call(arg0.read)"] */ pull() { read(); } });
}
/** @effects ["localstorage.write(*)"] */
function writer() { localStorage.clear(); }
/** @effects [] */
function entry() { createStream({ read: writer }); }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript' || item.code === 'syntax')).toEqual([]);
    const owner = result.owners.find(item => item.label === 'entry' && item.role === 'implementation')!;
    expect((result.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
  });

  it('includes module initialization startup callbacks', () => {
    const result = inspect({
      source: `\
export {};
new ReadableStream({ /** @effects ["localstorage.write(*)"] */ start() { localStorage.clear(); } });
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript' || item.code === 'syntax')).toEqual([]);
    const owner = result.owners.find(item => item.role === 'module')!;
    expect((result.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
  });

  it('keeps custom thenable startup results unsupported', () => {
    const result = inspect({
      source: `\
export {};
/** @effects [] */
function entry() {
  new ReadableStream({
    /** @effects [] */
    start() { return { /** @effects ["sessionstorage.write(*)"] */ then(resolve: (value: void) => void) { sessionStorage.clear(); resolve(); } }; },
  });
}
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('settlement'))).toBe(true);
  });

  it('keeps consumer cancellation unsupported without treating it as startup', () => {
    const result = inspect({
      source: `\
export {};
/** @effects [] */
function entry() {
  const stream = new ReadableStream({ /** @effects ["sessionstorage.write(*)"] */ cancel() { sessionStorage.clear(); } });
  stream.cancel();
}
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    const owner = result.owners.find(item => item.label === 'entry' && item.role === 'implementation')!;
    expect(result.solution.rows.get(owner.id)).toEqual([]);
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('property access: cancel'))).toBe(true);
  });

  it('preserves local constructor identity', () => {
    const result = inspect({
      source: `\
export {};
class ReadableStream { constructor(_source: { start: () => void }) {} }
/** @effects [] */
function entry() { new ReadableStream({ /** @effects ["localstorage.write(*)"] */ start() { localStorage.clear(); } }); }
`,
    });
    expect(result.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    const owner = result.owners.find(item => item.label === 'entry' && item.role === 'implementation')!;
    expect(result.solution.rows.get(owner.id)).toEqual([]);
    expect(result.diagnostics.some(item => item.message.includes('startup callbacks'))).toBe(false);
    expect(result.diagnostics.some(item => item.message.includes('ClassDeclaration'))).toBe(true);
  });
});
