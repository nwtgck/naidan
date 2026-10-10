import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFixture } from '../../test-support/project-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';
import { runEffectTidy } from '../../maintenance/tidy.ts';

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

const HTTP = ['network.http(*)'];
const FILE = ['hostfs.read(*)'];
const BOTH = [...FILE, ...HTTP];

describe('explicit image and navigation origins', () => {
  it.each([
    ['https://other.invalid/pixel?data=abc', HTTP],
    ['http://localhost/pixel', HTTP],
    ['HTTPS://other.invalid/pixel', HTTP],
    ['h\tt\ntps://other.invalid/pixel', HTTP],
    ['file:///tmp/image.png', FILE],
    ['/assets/image.png', BOTH],
    ['image.png', BOTH],
    ['//other.invalid/pixel', BOTH],
    ['\\\\other.invalid/pixel', BOTH],
    ['data:image/png;base64,AAAA', []],
    ['data:image/svg+xml,<svg/>', []],
    ['blob:https://naidan.invalid/token', []],
    ['blob:null/token', []],
  ] as const)('classifies a passive image URL with the standard parser: %s', (url, effects) => {
    expect(row({ source: `function entry() { const image = new Image(); image.src = ${JSON.stringify(url)}; }` })).toEqual(effects);
  });

  it.each([
    'new Image()', 'new Image(20, 30)', "document.createElement('img')", "document.createElement('IMG')",
  ])('does not charge for empty image creation: %s', creation => {
    expect(row({ source: `function entry() { const image = ${creation}; void image; }` })).toEqual([]);
  });

  it.each([
    "image.src = 'https://other.invalid/pixel';",
    "image['src'] = 'https://other.invalid/pixel';",
    "image.setAttribute('src', 'https://other.invalid/pixel');",
    "image.setAttribute('SRC', 'https://other.invalid/pixel');",
  ])('shares the origin policy for source assignment and attribute calls: %s', statement => {
    expect(row({ source: `function entry() { const image = new Image(); ${statement} }` })).toEqual(HTTP);
  });

  it('keeps immutable typed string and image evidence without trusting type assertions', () => {
    expect(row({ source: `function entry() { const image: HTMLImageElement = new Image(); const src: string = URL.createObjectURL(new Blob(['x'])); image.src = src; }` })).toEqual([]);
  });

  it('retains both choices instead of treating a mixed literal as a Blob', () => {
    expect(row({ source: `function entry({ yes }: { yes: boolean }) { const image = new Image(); image.src = yes ? 'blob:null/token' : 'https://other.invalid/pixel'; }` })).toEqual(HTTP);
  });

  it('does not classify addresses merely by the spelling of a local Image or navigator', () => {
    expect(row({ source: `const document = { createElement: (tag: string) => { localStorage.clear(); return tag; } }; function entry() { document.createElement('img'); } export {};` })).toEqual(['localstorage.write(*)']);
  });

  it('preserves the source network read when decoding a Response into a Blob image', () => {
    expect(row({ source: `async function entry() { const response = await fetch('https://other.invalid/picture'); const blob = await response.blob(); const src = URL.createObjectURL(blob); const image = new Image(); image.src = src; URL.revokeObjectURL(src); }` })).toEqual(HTTP);
  });

  it('preserves a filesystem read when presenting the already acquired File', () => {
    expect(row({ source: `async function entry() { const root = await navigator.storage.getDirectory(); const handle = await root.getFileHandle('image.png'); const file = await handle.getFile(); const image = new Image(); image.src = URL.createObjectURL(file); }` })).toEqual(['opfs.read(*)']);
  });

  it('checks argument evaluation even when the destination is a passive Blob image', () => {
    expect(row({ source: `function entry() { const image = new Image(); image.src = (localStorage.clear(), 'blob:null/token'); }` })).toEqual(['localstorage.write(*)']);
  });

  it.each([
    "window.open('https://other.invalid/path', '_blank', 'noopener,noreferrer');",
    "globalThis.open('https://other.invalid/path');",
    "location.assign('https://other.invalid/path');",
    "location.replace('https://other.invalid/path');",
    "location.href = 'https://other.invalid/path';",
    "window.location.href = 'https://other.invalid/path';",
    "document.location.href = 'https://other.invalid/path';",
    "globalThis.location.href = 'https://other.invalid/path';",
  ])('tracks explicit HTTP navigation: %s', statement => {
    expect(row({ source: `function entry() { ${statement} }` })).toEqual(HTTP);
  });

  it('supports a const bound Location method', () => {
    expect(row({ source: `function entry() { const navigate = location.assign; navigate('https://other.invalid/path'); }` })).toEqual(HTTP);
  });

  it('does not treat same-origin relative navigation as internal messaging', () => {
    expect(row({ source: "function entry() { location.assign('/app?message=123'); }" })).toEqual(BOTH);
  });

  it('does not trigger navigation when constructing a string', () => {
    expect(row({ source: "function entry() { const url = 'https://other.invalid/secret'; return url; }" })).toEqual([]);
  });
});

describe('DOM boundaries do not turn unsupported execution into none', () => {
  it.each([
    "window.open('blob:https://naidan.invalid/token');",
    "window.open('data:text/html,<script>1</script>');",
    "location.href = 'javascript:localStorage.clear()';",
    "window.open(URL.createObjectURL(new Blob(['<script>1</script>'])));",
    "new Image().src = 'javascript:localStorage.clear()';",
    "document.createElement('script');",
    "document.createElement('custom-widget');",
    "document.createElement('img', { is: 'custom-image' });",
    "const image = new Image(); image.srcset = 'https://other.invalid/a 1x';",
    "const image = new Image(); image.setAttribute('onerror', 'localStorage.clear()');",
    "const image = new Image(); image.setAttribute('srcset', 'https://other.invalid/a 1x');",
  ])('refuses rather than inventing a safe model: %s', statement => {
    const result = inspect({ source: `function entry() { ${statement} }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not use the src string as proof about an existing image srcset or picture', () => {
    const result = inspect({ source: `function entry({ image }: { image: HTMLImageElement }) { image.src = 'blob:null/token'; }` });
    expect(result.diagnostics.some(item => item.message.includes('srcset/picture'))).toBe(true);
  });

  it.each([
    `const address = input as 'blob:null/token'; image.src = address;`,
    `let address = 'blob:null/token'; address = input; image.src = address;`,
    `const state = { src: 'blob:null/token' }; state.src = input; image.src = state.src;`,
    `const state = { src: URL.createObjectURL(new Blob(['x'])) }; state.src = input; image.src = state.src;`,
    `const state: { src: string } = { src: URL.createObjectURL(new Blob(['x'])) }; const alias = state; alias.src = input; const copied = { ...state }; image.src = copied.src;`,
    `const state: { src: string } = { src: 'blob:null/token' }; state.src = input; const { src } = state; image.src = src;`,
    `const state = { src: 'blob:null/token' }; Object.assign(state, { src: input }); image.src = state.src;`,
    `const state = { nested: { src: 'blob:null/token' } }; state.nested = { src: input }; image.src = state.nested.src;`,
  ])('does not preserve stale URL facts through writable storage: %s', statement => {
    const result = inspect({ source: `function entry({ input }: { input: string }) { const image = new Image(); ${statement} }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('URL scheme/provenance'))).toBe(true);
  });

  it('does not manufacture evidence from a literal function return type', () => {
    const result = inspect({ source: `function source({ input }: { input: string }): 'blob:null/token' { return input as 'blob:null/token'; } function entry({ input }: { input: string }) { const image = new Image(); image.src = source({ input }); }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('URL scheme/provenance'))).toBe(true);
  });

  it('checks custom conversion even if a cast pretends it is a URL string', () => {
    const result = inspect({ source: `const input = { toString() { localStorage.clear(); return 'blob:null/token'; } }; function entry() { const image = new Image(); image.src = input as unknown as string; }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not inherit fresh-image proof from a forged type', () => {
    const result = inspect({ source: `function entry({ object }: { object: unknown }) { const image = object as HTMLImageElement; image.src = 'blob:null/token'; }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('records the none policy without claiming that its guard succeeded', () => {
    const result = inspect({ source: "function entry() { document.createElement('script'); }" });
    expect(result.modelDecisions.some(item => item.rule === 'image.create-element' && item.disposition === 'intentional-none')).toBe(true);
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });
});

describe('image origins participate in maintenance', () => {
  it('widens callers in one plan and does not add runtime statements', () => {
    const fixture = createFixture({
      files: {
        'image.ts': `export function display() { const image = new Image(); image.src = 'https://other.invalid/a'; }`,
        'main.ts': `import { display } from './image'; export function entry() { display(); }`,
      },
      entries: ['main.ts'],
    });
    try {
      const fixed = fixture.fix();
      expect(fixed.analysis.diagnostics).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toContain('@effects `network.http(*)`');
      expect(fixture.fix().changedFiles).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('keeps unsupported document execution unfixable', () => {
    const source = `function entry() { window.open('data:text/html,<script>1</script>'); }`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      expect(() => fixture.fix()).toThrow();
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
    } finally {
      fixture.dispose();
    }
  });
});

describe('DOM policy preservation and explicit tidy', () => {
  it('previews and writes a narrower image implementation without shrinking a shared slot', () => {
    const source = `\
/** @effects \`network.http(*)\` */
export function localImage() { const image = new Image(); image.src = 'blob:null/token'; }
export const actions = { /** @effects \`network.http(*)\` */ run: () => {} };
`;
    const fixture = createFixture({ files: { 'main.ts': source }, entries: ['main.ts'] });
    try {
      const input = { root: fixture.root, config: fixture.config, files: ['main.ts'], inputSnapshots: new Map<string, string>() };
      const preview = runEffectTidy({ ...input, write: 'preview' });
      expect(preview.changes).toHaveLength(1);
      expect(preview.changes[0]?.after).toEqual([]);
      expect(fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8')).toBe(source);
      const written = runEffectTidy({ ...input, write: 'write' });
      expect(written.changedFiles).toHaveLength(1);
      const text = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(text).toContain('/** @effects `none` */');
      expect(text).toContain('/** @effects `network.http(*)` */ run');
      expect(fixture.fix().changedFiles).toEqual([]);
      expect(runEffectTidy({ ...input, write: 'preview' }).changes).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  it('does not let image-network suppression hide unsupported document execution', () => {
    const result = inspect({
      source: `\
/** @effects \`none\` */
/** @effectsUNSAFE \`network.http(*)\` -- "Explicit network suppression for a test boundary." */
function entry() { window.open('data:text/html,<script>1</script>'); fetch('https://other.invalid/'); }
`,
    });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not suppress the stored data read needed to create an image', () => {
    expect(row({ source: `function entry() { const src = localStorage.getItem('image'); const image = new Image(); void src; image.src = 'blob:null/token'; }` })).toEqual(['localstorage.read(*)']);
  });

  it('rejects custom iteration of typed Blob parts', () => {
    const result = inspect({ source: 'function entry({ parts }: { parts: string[] }) { new Blob(parts); }' });
    expect(result.diagnostics.some(item => item.message.includes('Blob part iteration'))).toBe(true);
  });

  it('does not let a literal-typed declaration forge the element tag', () => {
    const result = inspect({ source: "function entry() { const tag: 'img' = 'script' as 'img'; document.createElement(tag); }" });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });

  it('does not use image source reads as local-URL evidence', () => {
    const result = inspect({ source: `function entry() { const image = new Image(); image.src = 'https://other.invalid/a'; const copy = new Image(); copy.src = image.src; }` });
    expect(result.diagnostics.some(item => item.message.includes('URL scheme/provenance'))).toBe(true);
  });
});

describe('fresh image evidence cannot survive arbitrary storage replacement', () => {
  it.each([
    `const state: { image: HTMLImageElement } = { image: new Image() }; state.image = existing; const copy = { ...state }; copy.image.src = 'blob:null/token';`,
    `const state: { nested: { image: HTMLImageElement } } = { nested: { image: new Image() } }; state.nested = { image: existing }; const copy = { ...state }; copy.nested.image.src = 'blob:null/token';`,
    `const state: { image: HTMLImageElement } = { image: new Image() }; Object.assign(state, { image: existing }); const copy = { ...state }; copy.image.src = 'blob:null/token';`,
  ])('does not resurrect a fresh image through reflected fields: %s', statement => {
    const result = inspect({ source: `function entry({ existing }: { existing: HTMLImageElement }) { ${statement} }` });
    expect(result.diagnostics.some(item => item.code === 'unsupported')).toBe(true);
  });
});
