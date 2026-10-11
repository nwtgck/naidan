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

function effects({ result, label }: { result: ReturnType<typeof analyze>, label: string }) {
  const owner = result.owners.find(owner => owner.label === label && (owner.role === 'implementation' || owner.role === 'module'));
  expect(owner).toBeDefined();
  return (result.solution.rows.get(owner!.id) ?? []).map(effect => printEffect({ effect }));
}

function expectBoundary({ result }: { result: ReturnType<typeof analyze> }) {
  expect(result.diagnostics.some(item => item.message === 'Unsupported effect statement: ClassDeclaration.')).toBe(true);
}

describe('class method body candidates', () => {
  it('discovers an uninvoked leaf and this-call chain without adding module execution', () => {
    const result = analyze({
      source: `\
export class Endpoint {
  request() { void fetch('https://example.invalid'); }
  send() { this.request(); }
  receive() { this.send(); }
}
`,
    });
    for (const label of ['request', 'send', 'receive']) expect(effects({ result, label })).toEqual(['network.http(*)']);
    expect(effects({ result, label: '<module>' })).toEqual([]);
    expectBoundary({ result });
  });

  it('preserves unknown construction and dispatch while collecting direct caller candidates', () => {
    const result = analyze({
      source: `\
class Endpoint { send() { void fetch('https://example.invalid'); } }
function entry() { new Endpoint().send(); }
`,
    });
    expect(effects({ result, label: 'entry' })).toEqual(['network.http(*)']);
    expect(result.diagnostics.some(item => item.message === 'Unverified property access: send.')).toBe(true);
    expect(result.diagnostics.some(item => item.message === 'The call target has no checked effect contract.')).toBe(true);
    expectBoundary({ result });
  });

  it('retains unknown construction while binding a known instance method to a structural slot', () => {
    const result = analyze({
      source: `\
interface Transport { send(): void; }
class Endpoint { send() { void fetch('https://example.invalid'); } }
function transfer({ endpoint }: { endpoint: Transport }) { endpoint.send(); }
function entry() { transfer({ endpoint: new Endpoint() }); }
`,
    });
    expect(effects({ result, label: 'send' })).toEqual(['network.http(*)']);
    expect(effects({ result, label: 'entry' })).toEqual(['network.http(*)']);
    expect(result.diagnostics.some(item => item.message === 'Class instance construction, fields and method dispatch remain unverified.')).toBe(true);
    expect(result.diagnostics.some(item => item.message === 'The call target has no checked effect contract.')).toBe(true);
    expectBoundary({ result });
  });

  it('does not claim constructor or field initializer effects have been checked', () => {
    const result = analyze({
      source: `\
class Endpoint {
  constructor() { localStorage.clear(); }
  field = sessionStorage.clear();
  send() { void fetch('https://example.invalid'); }
}
function entry() { new Endpoint().send(); }
`,
    });
    expect(effects({ result, label: 'entry' })).toEqual(['network.http(*)']);
    expect(effects({ result, label: '<module>' })).toEqual([]);
    expectBoundary({ result });
  });

  it('does not register getters computed methods or executable class initialization', () => {
    const result = analyze({
      source: `\
class Endpoint {
  get storage() { localStorage.clear(); return undefined; }
  ['computed']() { sessionStorage.clear(); }
  static { localStorage.clear(); }
  field = () => sessionStorage.clear();
  send() { void fetch('https://example.invalid'); }
}
`,
    });
    expect(result.owners.filter(owner => owner.role === 'implementation').map(owner => owner.label)).toEqual(['send']);
    expect(effects({ result, label: '<module>' })).toEqual([]);
    expectBoundary({ result });
  });

  it('retains a nested method captured callback without making declaration execute it', () => {
    const result = analyze({
      source: `\
function outer({ run }: { run: () => void }) {
  class Endpoint { send() { run(); } }
}
`,
    });
    expect(effects({ result, label: 'send' })).toEqual(['call(arg0.run)']);
    expect(effects({ result, label: 'outer' })).toEqual([]);
    expectBoundary({ result });
  });

  it('does not resolve an interface call through an inheritance or override assumption', () => {
    const result = analyze({
      source: `\
class Parent { send() { void fetch('https://example.invalid'); } }
class Child extends Parent { send() { localStorage.clear(); } }
function entry({ endpoint }: { endpoint: Parent }) { endpoint.send(); }
`,
    });
    expect(effects({ result, label: 'entry' })).toEqual(['call(arg0.endpoint.send)']);
    expectBoundary({ result });
  });
});
