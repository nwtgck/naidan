import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { printEffect } from '../contracts/effects.ts';
import { createFixture } from '../test-support/project-fixture.ts';

function checkSource({ source }: { source: string }) {
  const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
  try {
    return fixture.check();
  } finally {
    fixture.dispose();
  }
}

describe('executed binding defaults and iteration assignments', () => {
  it.each([
    'const { value = localStorage.clear() } = {}; void value;',
    'const [value = localStorage.clear()] = []; void value;',
    'for (const { value = localStorage.clear() } of [{}]) { void value; }',
  ])('includes the effects of a local binding default: %s', body => {
    const analysis = checkSource({ source: `/** @effects [] */ function main() { ${body} }` });
    expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'exceeds' && item.message.includes('localstorage.write(*)'))).toBe(true);
  });

  it('retains a callable produced by a default expression', () => {
    const analysis = checkSource({
      source: `\
/** @effects ["localstorage.write(*)"] */ function write() { localStorage.clear(); }
/** @effects [] */ function create() { return write; }
/** @effects [] */ function main() { const { run = create() } = {}; run(); }
`,
    });
    expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    const main = analysis.owners.find(owner => owner.label === 'main')!;
    expect(analysis.solution.rows.get(main.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
  });

  it('retains both callable candidates without reconstructing the default condition', () => {
    const analysis = checkSource({
      source: `\
/** @effects ["localstorage.read(*)"] */ function read() { localStorage.getItem('x'); }
/** @effects ["localstorage.write(*)"] */ function write() { localStorage.clear(); }
/** @effects ["localstorage.read(*)","localstorage.write(*)"] */
function main() { const { run = write } = { run: read }; run(); }
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('fixes and checks an anonymous default callback independently', () => {
    const fixture = createFixture({ files: { 'main.ts': 'function main() { const { run = () => { localStorage.clear(); } } = {}; run(); }' }, entries: ['main.ts'] });
    try {
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      expect(result.analysis.coverage.functions).toBe(2);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8').match(/@effects \["localstorage.write\(\*\)"\]/g)).toHaveLength(2);
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('does not certify an unresolved optional callable through its fallback', () => {
    const analysis = checkSource({
      source: `\
/** @effects ["localstorage.write(*)"] */ function write() { localStorage.clear(); }
/** @effects [] */ function main({ run }: { run: (() => void) | undefined }) {
  const { selected = write } = { selected: run };
  selected();
}
`,
    });
    expect(analysis.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it.each(['localStorage.x', 'sessionStorage.x', 'document.cookie'])('checks the existing for-of assignment destination: %s', destination => {
    const analysis = checkSource({ source: `/** @effects [] */ function main() { for (${destination} of ['value']) {} }` });
    expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'exceeds' && item.message.includes('.write(*)'))).toBe(true);
  });

  it('checks effects in a for-of destination key expression', () => {
    const analysis = checkSource({
      source: `\
/** @effects ["localstorage.read(*)"] */ function key() { localStorage.getItem('x'); return 'x'; }
/** @effects [] */ function main() { for (localStorage[key()] of ['value']) {} }
`,
    });
    expect(analysis.diagnostics.filter(item => item.code !== 'exceeds')).toEqual([]);
    const main = analysis.owners.find(owner => owner.label === 'main')!;
    expect(analysis.solution.rows.get(main.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.read(*)', 'localstorage.write(*)']);
  });

  it('keeps scalar defaults and existing scalar destinations effect-free', () => {
    const analysis = checkSource({
      source: `\
/** @effects [] */ function main() {
  const { width = 512 } = {};
  const [red = 0] = [];
  let value = '';
  for (value of ['x']) {}
  void width; void red; void value;
}
`,
    });
    expect(analysis.diagnostics).toEqual([]);
  });

  it('does not skip an unsupported computed binding key expression', () => {
    const analysis = checkSource({
      source: `\
/** @effects ["localstorage.write(*)"] */ function key() { localStorage.clear(); return 'x'; }
/** @effects [] */ function main() { const { [key()]: value = 0 } = {}; void value; }
`,
    });
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('Computed binding'))).toBe(true);
  });

  it('does not retain a mutable default URL as evidence of local-only image content', () => {
    const analysis = checkSource({
      source: `\
/** @effects [] */ function main() {
  let { url = 'data:image/png;base64,AA==' } = {};
  url = 'https://example.test/image.png';
  const image = new Image();
  image.src = url;
}
`,
    });
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'exceeds' && item.message.includes('network.http(*)'))).toBe(true);
  });
});

describe('body-less function declarations retain existing boundary requirements', () => {
  it('refuses a .ts ambient function instead of trusting its annotation', () => {
    const fixture = createFixture({ files: { 'main.ts': '/** @effects [] */ declare function send(): void; /** @effects [] */ function main() { send(); }' }, entries: ['main.ts'] });
    try {
      expect(fixture.check().diagnostics.some(item => item.code === 'boundary')).toBe(true);
      expect(() => fixture.fix()).toThrow('refused');
    } finally {
      fixture.dispose();
    }
  });

  it('refuses an overload whose body effects would otherwise disappear from its caller', () => {
    const fixture = createFixture({
      files: {
        'main.ts': `\
/** @effects [] */ function send(): void;
/** @effects ["localstorage.write(*)"] */ function send() { localStorage.clear(); }
/** @effects [] */ function main() { send(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
      expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('without a body'))).toBe(true);
      expect(() => fixture.fix()).toThrow('refused');
    } finally {
      fixture.dispose();
    }
  });
});
