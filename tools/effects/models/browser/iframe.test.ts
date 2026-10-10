import { describe, expect, it } from 'vitest';
import { createFixture } from '../../test-support/project-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';
import { planEffectFix } from '../../fixes/plan.ts';

function inspect({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

function entryEffects({ analysis }: { analysis: ReturnType<typeof inspect> }): readonly string[] {
  const owner = analysis.owners.find(owner => owner.label === 'entry')!;
  return analysis.solution.rows.get(owner.id)!.map(effect => printEffect({ effect })).sort();
}

describe('native iframe browsing-context reads', () => {
  it('reads the nullable context without charging delivery or modeling other DOM operations', () => {
    const analysis = inspect({ source: `function entry({ iframe }: { iframe: HTMLIFrameElement }) { void iframe.contentWindow; }` });
    expect(entryEffects({ analysis })).toEqual([]);
    expect(analysis.diagnostics.filter(item => item.code !== 'missing')).toEqual([]);
    expect(analysis.modelDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'iframe.content-window', disposition: 'intentional-none', effects: [] }),
    ]));
  });

  it.each([
    `iframe.contentWindow!.postMessage('x', '*');`,
    `const target = iframe.contentWindow; if (target === null) return; target.postMessage('x', '*');`,
  ])('retains send effects and the unresolved nullable alternative: %s', body => {
    const analysis = inspect({ source: `function entry({ iframe }: { iframe: HTMLIFrameElement }) { ${body} }` });
    expect(entryEffects({ analysis })).toEqual(['messaging.crossorigin.send(*)']);
    expect(analysis.diagnostics.some(item => item.code === 'typescript')).toBe(false);
    expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message === 'The call target has no checked effect contract.')).toBe(true);
    expect(() => planEffectFix({ analysis })).toThrow();
  });

  it('keeps a shadowed type as an application callback contract', () => {
    const analysis = inspect({
      source: `\
export {};
interface HTMLIFrameElement { contentWindow: { postMessage(message: string, target: string): void } }
function entry({ iframe }: { iframe: HTMLIFrameElement }) { iframe.contentWindow.postMessage('x', '*'); }
`,
    });
    expect(entryEffects({ analysis })).toEqual(['call(arg0.iframe.contentWindow.postMessage)']);
    expect(analysis.modelDecisions.some(item => item.rule === 'iframe.content-window' || item.rule === 'window.message.send')).toBe(false);
  });

  it.each([
    `const iframe = {} as unknown as HTMLIFrameElement; iframe.contentWindow!.postMessage('x', '*');`,
    `const iframe = { get contentWindow() { localStorage.clear(); return window.parent; } }; iframe.contentWindow.postMessage('x', '*');`,
  ])('does not turn casts or custom getters into a native context: %s', body => {
    const analysis = inspect({ source: `function entry() { ${body} }` });
    expect(analysis.modelDecisions.some(item => item.rule === 'iframe.content-window' || item.rule === 'window.message.send')).toBe(false);
    expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(() => planEffectFix({ analysis })).toThrow();
  });

  it('keeps the conversion boundary when an explicit slot type accompanies a fake cast', () => {
    const analysis = inspect({ source: `function entry() { const iframe: HTMLIFrameElement = {} as unknown as HTMLIFrameElement; iframe.contentWindow!.postMessage('x', '*'); }` });
    expect(analysis.diagnostics.some(item => item.message === 'Unsupported or unresolved effect value conversion: record to native.')).toBe(true);
    expect(() => planEffectFix({ analysis })).toThrow();
  });

  it('does not classify a local postMessage implementation as native delivery', () => {
    const analysis = inspect({ source: `function entry() { const iframe = { contentWindow: { postMessage(message: string, target: string) { localStorage.clear(); } } }; iframe.contentWindow.postMessage('x', '*'); }` });
    expect(entryEffects({ analysis })).toEqual(['localstorage.write(*)']);
    expect(analysis.modelDecisions.some(item => item.rule === 'iframe.content-window' || item.rule === 'window.message.send')).toBe(false);
  });

  it('retains a blocking boundary for unmodeled iframe navigation', () => {
    const analysis = inspect({ source: `function entry({ iframe }: { iframe: HTMLIFrameElement }) { iframe.src = 'https://other.invalid/'; }` });
    expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
    expect(() => planEffectFix({ analysis })).toThrow();
  });
});
