import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { createEffectsProgram, typescriptDiagnostics } from '../project.ts';
import { printEffect } from '../contracts/effects.ts';
import { EffectsAnalyzer } from './analyze.ts';

function analyze({ source }: { source: string }) {
  using fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  const program = createEffectsProgram({ root: fixture.root, config: fixture.config, overlays: new Map() });
  expect(typescriptDiagnostics({ program })).toEqual([]);
  return new EffectsAnalyzer({ root: fixture.root, config: fixture.config, program }).analyze();
}

function entryEffects({ result }: { result: ReturnType<typeof analyze> }) {
  const entry = result.owners.find(owner => owner.role === 'implementation' && owner.label === 'entry')!;
  return (result.solution.rows.get(entry.id) ?? []).map(effect => printEffect({ effect }));
}

function expectUnverifiedClass({ result }: { result: ReturnType<typeof analyze> }) {
  expect(result.diagnostics.some(item => item.message === 'Unsupported effect statement: ClassDeclaration.')).toBe(true);
  expect(result.diagnostics.some(item => item.message === 'The call target has no checked effect contract.')).toBe(true);
}

describe('unverified class instance method candidates', () => {
  it('binds a known method to a finite structural callback slot', () => {
    const result = analyze({
      source: `\
interface Transfer { send(): void; }
class Endpoint { send() { void fetch('https://example.invalid'); } }
function transfer({ endpoint }: { endpoint: Transfer }) { endpoint.send(); }
function entry() { transfer({ endpoint: new Endpoint() }); }
`,
    });
    expect(entryEffects({ result })).toEqual(['network.http(*)']);
    expectUnverifiedClass({ result });
    expect(result.diagnostics.some(item => item.message === 'Class instance construction, fields and method dispatch remain unverified.')).toBe(true);
  });

  it('does not select class methods for an unrelated structural parameter', () => {
    const result = analyze({
      source: `\
interface Transfer { send(): void; }
class Endpoint { send() { void fetch('https://example.invalid'); } }
function transfer({ endpoint }: { endpoint: Transfer }) { endpoint.send(); }
function entry({ endpoint }: { endpoint: Transfer }) { transfer({ endpoint }); }
`,
    });
    expect(entryEffects({ result })).toEqual(['call(arg0.endpoint.send)']);
    expect(result.diagnostics.some(item => item.message === 'Unsupported effect statement: ClassDeclaration.')).toBe(true);
  });

  it('retains a static filesystem return contract', () => {
    const result = analyze({
      source: `\
class Endpoint { handle({ handle }: { handle: FileSystemFileHandle }): FileSystemFileHandle { return handle; } }
function entry({ handle }: { handle: FileSystemFileHandle }) { void new Endpoint().handle({ handle }).getFile(); }
`,
    });
    expect(entryEffects({ result })).toEqual(['hostfs.read(*)', 'opfs.read(*)']);
    expectUnverifiedClass({ result });
    expect(result.diagnostics.some(item => item.message === 'Unverified property access: handle.')).toBe(true);
  });

  it('retains the declared effect upper bound of a returned callback', () => {
    const result = analyze({
      source: `\
/** @effects ["network.http(*)"] */ type Callback = () => void;
class Endpoint { callback(): Callback { return () => {}; } }
function entry() { new Endpoint().callback()(); }
`,
    });
    expect(entryEffects({ result })).toEqual(['network.http(*)']);
    expectUnverifiedClass({ result });
  });

  it('keeps a class instance outside the closed message payload model', () => {
    const result = analyze({
      source: `\
class Endpoint { send() { void fetch('https://example.invalid'); } }
function entry() { window.parent.postMessage(new Endpoint(), '*'); }
`,
    });
    expect(result.diagnostics.some(item => item.message.startsWith('Message serialization requires checked scalar/closed data'))).toBe(true);
    expectUnverifiedClass({ result });
  });

  it('keeps an open instance outside checked Promise settlement', () => {
    const result = analyze({
      source: `\
class Endpoint { send() { void fetch('https://example.invalid'); } }
async function entry() { await new Endpoint(); }
`,
    });
    expect(result.diagnostics.some(item => item.message.startsWith('Unverified Promise settlement:'))).toBe(true);
    expect(entryEffects({ result })).toEqual([]);
    expectUnverifiedClass({ result });
  });

  it('does not turn prototype method candidates into enumerable own spread data', () => {
    const result = analyze({
      source: `\
class Endpoint { send() { void fetch('https://example.invalid'); } }
function entry() { void { ...new Endpoint() }; }
`,
    });
    expect(result.diagnostics.some(item => item.message.toLowerCase().includes('spread'))).toBe(true);
    expectUnverifiedClass({ result });
  });

  it('retains ordinary closed record reflection', () => {
    const result = analyze({
      source: `\
/** @effects ["messaging.crossorigin.send(*)"] */
function entry() { const value: { value: string } = { value: 'ok' }; window.parent.postMessage(value, '*'); }
`,
    });
    expect(entryEffects({ result })).toEqual(['messaging.crossorigin.send(*)']);
    expect(result.diagnostics).toEqual([]);
  });

  it('keeps getters outside a known ordinary method projection', () => {
    const result = analyze({
      source: `\
class Endpoint { get send() { return () => localStorage.clear(); } unused() {} }
function entry() { new Endpoint().send(); }
`,
    });
    expect(entryEffects({ result })).toEqual([]);
    expect(result.diagnostics.some(item => item.message === 'Unverified property access: send.')).toBe(true);
    expectUnverifiedClass({ result });
  });

  it('does not select an inherited or overridden instance method for a callback slot', () => {
    const result = analyze({
      source: `\
interface Transfer { send(): void; }
class Parent { send() { void fetch('https://example.invalid'); } }
class Child extends Parent { send() { localStorage.clear(); } }
function transfer({ endpoint }: { endpoint: Transfer }) { endpoint.send(); }
function entry() { transfer({ endpoint: new Child() }); }
`,
    });
    expect(entryEffects({ result })).toEqual(['call(arg0.endpoint.send)']);
    expectUnverifiedClass({ result });
  });

  it('does not make constructor or field initialization part of a checked instance contract', () => {
    const result = analyze({
      source: `\
interface Transfer { send(): void; }
class Endpoint {
  constructor() { localStorage.clear(); }
  field = sessionStorage.clear();
  send() { void fetch('https://example.invalid'); }
}
function transfer({ endpoint }: { endpoint: Transfer }) { endpoint.send(); }
function entry() { transfer({ endpoint: new Endpoint() }); }
`,
    });
    expect(entryEffects({ result })).toEqual(['network.http(*)']);
    expectUnverifiedClass({ result });
    expect(result.diagnostics.some(item => item.message === 'Class instance construction, fields and method dispatch remain unverified.')).toBe(true);
  });

  it('does not include static methods in the instance slot projection', () => {
    const result = analyze({
      source: `\
class Endpoint { static send() { localStorage.clear(); } unused() {} }
function entry() { void new Endpoint(); }
`,
    });
    expect(entryEffects({ result })).toEqual([]);
    expectUnverifiedClass({ result });
  });

  it('leaves an unresolved constructor alias outside the finite class projection', () => {
    const result = analyze({
      source: `\
interface Transfer { send(): void; }
class Endpoint { send() { void fetch('https://example.invalid'); } }
const Constructor = Endpoint;
function transfer({ endpoint }: { endpoint: Transfer }) { endpoint.send(); }
function entry() { transfer({ endpoint: new Constructor() }); }
`,
    });
    expect(entryEffects({ result })).toEqual(['call(arg0.endpoint.send)']);
    expectUnverifiedClass({ result });
  });
});
