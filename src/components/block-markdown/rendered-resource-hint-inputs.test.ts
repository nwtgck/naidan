import { describe, expect, it, vi } from 'vitest';
import { collectRenderedResourceHintInputs } from './rendered-resource-hint-inputs';

function renderFixture({ html }: { html: string }) {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return {
    root,
    [Symbol.dispose]() {
      root.remove();
    },
  };
}

describe('rendered resource hint inputs', () => {
  it('observes direct rendered resources and native forms without changing their content', () => {
    using fixture = renderFixture({
      html: `\
<video src="https://media.invalid/video" poster="https://images.invalid/poster"><source src="https://media.invalid/alternative"><track src="https://media.invalid/captions"></video>
<audio src="https://media.invalid/audio"></audio>
<svg><image src="https://unknown.invalid/ignored-svg-src" href="https://images.invalid/svg"></image><use href="https://unknown.invalid/use"></use></svg>
<img src="">
<input type="image" src="https://images.invalid/button">
<table background="https://images.invalid/table"><tbody><tr><td background="https://images.invalid/cell">Cell</td></tr></tbody></table>
<picture><source srcset="https://unknown.invalid/picture 1x"></picture>
<form action="https://forms.invalid/post" method="post"><button>Submit</button></form>
<form method="get"><input name="search"></form>
<form action="https://unknown.invalid/dialog" method="dialog"><button>Close</button></form>`,
    });
    const before = fixture.root.innerHTML;
    using fetch = vi.spyOn(globalThis, 'fetch');
    const targets = collectRenderedResourceHintInputs({ root: fixture.root });
    expect(targets.map(target => [target.destination, target.url])).toEqual(expect.arrayContaining([
      ['image', 'https://images.invalid/poster'],
      ['media', 'https://media.invalid/video'],
      ['media', 'https://media.invalid/alternative'],
      ['media', 'https://media.invalid/captions'],
      ['media', 'https://media.invalid/audio'],
      ['image', 'https://images.invalid/svg'],
      ['image', 'https://images.invalid/button'],
      ['image', 'https://images.invalid/table'],
      ['image', 'https://images.invalid/cell'],
      ['form', 'https://forms.invalid/post'],
      ['form', document.URL],
    ]));
    expect(targets.every(target => !target.url.includes('unknown.invalid'))).toBe(true);
    expect(fixture.root.innerHTML).toBe(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads existing inline CSS rules but does not follow imported stylesheets', () => {
    using fixture = renderFixture({
      html: `\
<style>
@import url("https://styles.invalid/import.css");
@font-face { font-family: Test; src: url("https://fonts.invalid/font.woff2") format("woff2"); }
.content { background-image: url("https://images.invalid/background"); content: "url(https://unknown.invalid/text)"; }
@media screen { .content { cursor: url("https://images.invalid/cursor"), auto; } }
</style>
<div class="content" style="background-image:url(https://images.invalid/inline)"></div>`,
    });
    const targets = collectRenderedResourceHintInputs({ root: fixture.root });
    expect(targets.map(target => [target.destination, target.url])).toEqual(expect.arrayContaining([
      ['style', 'https://styles.invalid/import.css'],
      ['image', 'https://images.invalid/background'],
      ['image', 'https://images.invalid/cursor'],
      ['image', 'https://images.invalid/inline'],
    ]));
    expect(targets.every(target => !target.url.includes('unknown.invalid'))).toBe(true);
  });

  it('reads font descriptors when the existing CSSOM exposes them', () => {
    using fixture = renderFixture({ html: '<style>@font-face {font-family: Test}</style>' });
    const rule = fixture.root.querySelector('style')!.sheet!.cssRules[0] as CSSFontFaceRule;
    // jsdom currently drops font-face src descriptors. Model the native CSSOM
    // value without creating or loading another stylesheet or font.
    using _descriptor = vi.spyOn(rule.style, 'getPropertyValue').mockImplementation(property => property === 'src' ? 'url("https://fonts.invalid/font.woff2") format("woff2")' : '');
    expect(collectRenderedResourceHintInputs({ root: fixture.root })).toEqual([
      { url: 'https://fonts.invalid/font.woff2', destination: 'font', realm: 'document' },
    ]);
  });

  it('deduplicates targets and preserves relative URL resolution', () => {
    using fixture = renderFixture({ html: '<video poster="/cover"><img src="/cover"><input type="image" src="/button"></video>' });
    expect(collectRenderedResourceHintInputs({ root: fixture.root })).toEqual([
      { url: new URL('/cover', document.baseURI).href, destination: 'image', realm: 'document' },
      { url: new URL('/button', document.baseURI).href, destination: 'image', realm: 'document' },
    ]);
  });

  it('does not mistake a different CSS function name or escaped URL for another resource', () => {
    using fixture = renderFixture({ html: '<div></div>' });
    const style = fixture.root.querySelector('div')!.style;
    using read = vi.spyOn(style, 'getPropertyValue').mockImplementation(property => property === 'background-image' ? 'éurl(https://unknown.invalid/not-a-url-function)' : '');
    expect(collectRenderedResourceHintInputs({ root: fixture.root })).toEqual([]);
    read.mockImplementation(property => property === 'background-image' ? String.raw`url("https://images.invalid/a\"url(https://unknown.invalid/not-a-second-request)")` : '');
    expect(collectRenderedResourceHintInputs({ root: fixture.root })).toEqual([]);
  });

  it('returns no partial hints after an inspection failure or resource budget overflow', () => {
    using invalid = renderFixture({ html: '<img src="https://images.invalid/valid"><img src="http://[">' });
    expect(collectRenderedResourceHintInputs({ root: invalid.root })).toEqual([]);
    using overflow = renderFixture({ html: Array.from({ length: 17 }, (_, index) => `<img src="https://images.invalid/${index}">`).join('') });
    expect(collectRenderedResourceHintInputs({ root: overflow.root })).toEqual([]);
    using throwing = renderFixture({ html: '<img src="https://images.invalid/valid">' });
    Object.defineProperty(throwing.root, 'baseURI', {
      get() {
        throw new Error('inspection failed');
      },
    });
    expect(collectRenderedResourceHintInputs({ root: throwing.root })).toEqual([]);
  });
});
