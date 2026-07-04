import path from 'node:path';
import { compile } from '@vue/compiler-dom';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  collectTwCandidateOccurrencesFromVueSource,
  createTwClassNodeTransform,
  parseStaticTwClassExpression,
  transformTwCallsInModule,
  transformTwCallsInVueSource,
} from './tw-class-core';
import { createTailwindCandidateValidator } from './tailwind-candidate-validator';
import { scriptKindForFilename } from './typescript-ast-utils';

function compileTemplate(template: string): string {
  return compile(template, {
    mode: 'module',
    nodeTransforms: [createTwClassNodeTransform({ filename: 'Fixture.vue', blockStart: undefined })],
  }).code;
}

function generatedPosition({ source, needle }: { source: string, needle: string }): { line: number, column: number } {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`Generated source does not contain ${JSON.stringify(needle)}.`);
  const prefix = source.slice(0, index);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  return {
    line: prefix.split('\n').length,
    column: index - lineStart,
  };
}

describe('tw-class compiler transform', () => {
  it('matches Vue static class output', () => {
    expect(compileTemplate('<div tw-class="flex gap-2" />'))
      .toBe(compileTemplate('<div class="flex gap-2" />'));
  });

  it('accepts statically enumerable conditional, array, and object forms', () => {
    expect(parseStaticTwClassExpression({
      expression: "[active ? 'opacity-100' : 'opacity-0', { hidden: disabled }, ready && 'block']",
      filename: 'Fixture.vue',
    })).toEqual(['opacity-100', 'opacity-0', 'hidden', 'block']);
  });

  it('merges custom :class and :tw-class into one Vue class binding', () => {
    const code = compileTemplate('<div :class="customClasses" :tw-class="active ? \'block\' : \'hidden\'" />');
    expect(code).toContain("[_ctx.customClasses, _ctx.active ? 'block' : 'hidden']");
  });

  it('unwraps an explicitly typed opaque twClasses() binding', () => {
    const code = compileTemplate('<div :tw-class="twClasses(computedClasses)" />');
    expect(code).toContain('class: _normalizeClass(_ctx.computedClasses)');
    expect(code).not.toContain('twClasses');
  });

  it('unwraps customClasses() from an ordinary :class binding', () => {
    const code = compileTemplate('<div :class="customClasses(computedClasses)" />');
    expect(code).toContain('class: _normalizeClass(_ctx.computedClasses)');
    expect(code).not.toContain('customClasses');
  });

  it('rejects nested compile-time class wrappers instead of leaking them into render code', () => {
    expect(() => compileTemplate('<div :tw-class="twClasses(twClasses(computedClasses))" />'))
      .toThrow(/twClasses\(\) may not be nested/u);
    expect(() => compileTemplate('<div :tw-class="twClasses(customClasses(computedClasses))" />'))
      .toThrow(/customClasses\(\) may not be nested/u);
    expect(() => compileTemplate('<div :class="customClasses(customClasses(computedClasses))" />'))
      .toThrow(/customClasses\(\) may not be nested/u);
  });

  it('rejects class wrappers outside their compile-time positions', () => {
    expect(() => compileTemplate('<div :class="[customClasses(computedClasses)]" />'))
      .toThrow(/customClasses\(\) may only be used as the complete value/u);
    expect(() => compileTemplate('<div :class="twClasses(computedClasses)" />'))
      .toThrow(/twClasses\(\) may only be used/u);
    expect(() => compileTemplate('<div :tw-class="{ flex: twClasses(computedClasses) }" />'))
      .toThrow(/twClasses\(\) may not be used as a condition/u);
    expect(() => compileTemplate(`<div :tw-class="twClasses(computedClasses) && 'flex'" />`))
      .toThrow(/twClasses\(\) may not be used as a condition/u);
    expect(() => compileTemplate('<div :tw-class="{ flex: customClasses(computedClasses) }" />'))
      .toThrow(/customClasses\(\) may not be used as a condition/u);
    expect(() => compileTemplate(`<div :tw-class="{ flex: tw('p-2') }" />`))
      .toThrow(/tw\(\) is not supported in Vue template expressions/u);
    expect(() => compileTemplate(`<div :class="twClassString('p-2')" />`))
      .toThrow(/twClassString\(\) is not supported in Vue template expressions/u);
    expect(() => compileTemplate(`<div :class="customClasses(tw('p-2'))" />`))
      .toThrow(/tw\(\) is not supported in Vue template expressions/u);
  });

  it('rejects unwrapped opaque :tw-class expressions', () => {
    expect(() => compileTemplate('<div :tw-class="computedClasses" />'))
      .toThrow(/statically enumerable or wrapped in twClasses/u);
  });

  it('rejects static and dynamic tw-class on the same element for vue-tsc compatibility', () => {
    expect(() => compileTemplate(`<div tw-class="p-2" :tw-class="active ? 'block' : 'hidden'" />`))
      .toThrow(/vue-tsc treats them as duplicate attributes/u);
  });


  it('restores Vue Transition Tailwind class attributes at compile time', () => {
    const transformed = compileTemplate(`
      <Transition
        tw-enter-active-class="transition duration-200 ease-out"
        tw-enter-from-class="translate-y-2 opacity-0"
        tw-enter-to-class="translate-y-0 opacity-100"
        tw-leave-active-class="transition duration-150 ease-in"
        tw-leave-from-class="translate-y-0 opacity-100"
        tw-leave-to-class="translate-y-2 opacity-0"
      ><div /></Transition>
    `);
    const ordinary = compileTemplate(`
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-2 opacity-0"
        enter-to-class="translate-y-0 opacity-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="translate-y-0 opacity-100"
        leave-to-class="translate-y-2 opacity-0"
      ><div /></Transition>
    `);
    expect(transformed).toBe(ordinary);
  });

  it('restores vuedraggable Tailwind class options and preserves custom class prefixes', () => {
    const transformed = compileTemplate('<draggable ghost-class="sortable-ghost" tw-fallback-class="opacity-0" />');
    const ordinary = compileTemplate('<draggable ghost-class="sortable-ghost" fallback-class="opacity-0" />');
    expect(transformed).toBe(ordinary);
  });

  it('rejects v-bind modifiers on registered Tailwind class attributes', () => {
    expect(() => compileTemplate(`<div :tw-class.prop="'p-2'" />`))
      .toThrow(/:tw-class does not support v-bind modifiers/u);
    expect(() => collectTwCandidateOccurrencesFromVueSource({
      source: `<template><Transition :tw-enter-active-class.camel="'transition'" /></template>`,
      filename: 'ModifiedAttribute.vue',
    })).toThrow(/:tw-enter-active-class does not support v-bind modifiers/u);
  });

  it('rejects unregistered tw-prefixed attributes', () => {
    expect(() => compileTemplate('<div tw-content-class="p-2" />'))
      .toThrow(/Unknown Tailwind class attribute tw-content-class/u);
  });
});

describe('Vue candidate collection', () => {
  it('uses absolute SFC locations and the same attribute validation as compilation', () => {
    const source = '<template><div tw-class="p-2 m-1" /></template>\n';
    expect(collectTwCandidateOccurrencesFromVueSource({
      source,
      filename: 'SameLine.vue',
    })).toEqual([
      expect.objectContaining({ candidate: 'p-2', line: 1, column: 16 }),
      expect.objectContaining({ candidate: 'm-1', line: 1, column: 16 }),
    ]);

    expect(() => collectTwCandidateOccurrencesFromVueSource({
      source: '<template><div tw-content-class="p-2" /></template>\n',
      filename: 'Invalid.vue',
    })).toThrow(/Invalid\.vue:1:16 Unknown Tailwind class attribute tw-content-class/u);
  });

  it('reports exact positions for macros in a same-line script block', () => {
    const source = `<script setup lang="ts">import { tw } from 'virtual:naidan-tailwind'; const value = tw('p-2');</script><template><div /></template>
`;
    expect(collectTwCandidateOccurrencesFromVueSource({
      source,
      filename: 'SameLineScript.vue',
    })).toContainEqual(expect.objectContaining({
      candidate: 'p-2',
      line: 1,
      column: 85,
      sourceKind: 'tw()',
    }));
  });


  it('reports macro failures at absolute same-line Vue script positions', () => {
    const source = `<script setup lang="ts">import { tw } from 'virtual:naidan-tailwind'; const value = tw(dynamicValue);</script><template><div /></template>
`;
    expect(() => collectTwCandidateOccurrencesFromVueSource({
      source,
      filename: 'SameLineInvalid.vue',
    })).toThrow(/SameLineInvalid\.vue:1:85 tw\(\) requires exactly one string literal/u);
  });
});

describe('tw macro', () => {
  it('keeps .mjs files on the JavaScript parser after the TypeScript migration', () => {
    expect(scriptKindForFilename({ filename: 'fixture.mjs' })).toBe(ts.ScriptKind.JS);
  });

  it('replaces a literal call and removes all compile-time macro imports', () => {
    const result = transformTwCallsInModule({
      source: `\
import { tw, twClasses } from 'virtual:naidan-tailwind';
const value = tw('opacity-50');
`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    });
    expect(result.code).not.toContain('virtual:naidan-tailwind');
    expect(result.code).toContain('const value = "opacity-50";');
    expect(result.occurrences.map(({ candidate }) => candidate)).toEqual(['opacity-50']);
  });


  it('transforms only imported macro bindings and ignores shadowed local names', () => {
    const result = transformTwCallsInModule({
      source: `\
import { tw, twClassString } from 'virtual:naidan-tailwind';
const direct = tw('p-1');
const wrapped = (tw)('m-1');
function local(tw: (value: string) => string, twClassString: (value: string) => string) {
  return [tw(dynamicValue), twClassString(dynamicValue)];
}
`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    });
    expect(result.code).toContain('const direct = "p-1";');
    expect(result.code).toContain('const wrapped = "m-1";');
    expect(result.code).toContain('return [tw(dynamicValue), twClassString(dynamicValue)];');
    expect(result.occurrences.map(({ candidate }) => candidate)).toEqual(['p-1', 'm-1']);
  });

  it('rejects runtime loading and re-export of the compile-time macro module', () => {
    const unsupportedSources = [
      `const macros = import('virtual:naidan-tailwind');`,
      `const macros = import('virtual:naidan-tailwind' + suffix);`,
      `const macros = require('virtual:naidan-tailwind');`,
      `export { tw } from 'virtual:naidan-tailwind';`,
      `import macros = require('virtual:naidan-tailwind');`,
    ];
    for (const source of unsupportedSources) {
      expect(() => transformTwCallsInModule({
        source,
        filename: 'fixture.ts',
        sourceType: 'typescript',
        blockStart: { line: 1, column: 1 },
        additionalImports: [],
      })).toThrow(/virtual:naidan-tailwind/u);
    }
  });

  it('ignores the reserved module ID when it is only ordinary fixture data', () => {
    const result = transformTwCallsInModule({
      source: `const macroId = 'virtual:naidan-tailwind';`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    });
    expect(result.changed).toBe(false);
  });

  it('collapses twClassString() to one literal and records every candidate', () => {
    const result = transformTwCallsInModule({
      source: `\
import { twClassString } from 'virtual:naidan-tailwind';
const value = twClassString('rounded-xl', 'dark:border-gray-800');
`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    });
    expect(result.code).not.toContain('twClassString');
    expect(result.code).toContain('const value = "rounded-xl dark:border-gray-800";');
    expect(result.occurrences.map(({ candidate }) => candidate)).toEqual([
      'rounded-xl',
      'dark:border-gray-800',
    ]);
  });

  it('rejects empty, dynamic, and multi-token twClassString arguments', () => {
    expect(() => transformTwCallsInModule({
      source: `import { twClassString } from 'virtual:naidan-tailwind'; twClassString();`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    })).toThrow(/one or more string literals/u);
    expect(() => transformTwCallsInModule({
      source: `import { twClassString } from 'virtual:naidan-tailwind'; twClassString(value);`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    })).toThrow(/one or more string literals/u);
    expect(() => transformTwCallsInModule({
      source: `import { twClassString } from 'virtual:naidan-tailwind'; twClassString('flex gap-2');`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    })).toThrow(/Each twClassString/u);
  });

  it('preserves Vue script positions when macros and virtual CSS imports are transformed together', () => {
    const source = `<script setup lang="ts">
import { tw } from 'virtual:naidan-tailwind';
const before = 1;
const value = tw('opacity-50');
const after = 2;
</script>
<template><div /></template>
`;
    const result = transformTwCallsInVueSource({
      source,
      filename: 'Fixture.vue',
      additionalImports: ['virtual:naidan-tailwind-css/example.css'],
    });
    expect(result.code).toContain('const value = "opacity-50";');
    expect(result.code).toContain('import "virtual:naidan-tailwind-css/example.css";');
    expect(result.map).not.toBeNull();
    const map = new TraceMap(JSON.parse(String(result.map)));
    const original = originalPositionFor(map, generatedPosition({
      source: result.code,
      needle: 'const after = 2;',
    }));
    expect(original.source).toBe('Fixture.vue');
    expect(original.line).toBe(5);
    expect(original.column).toBe(0);
  });

  it('parses macros in Vue JavaScript, JSX, TypeScript, and TSX script blocks with matching syntax', () => {
    const fixtures = [
      {
        language: '',
        body: `const value = tw('p-1');`,
        candidate: 'p-1',
      },
      {
        language: ' lang="jsx"',
        body: `const view = <div className={tw('p-2')} />;`,
        candidate: 'p-2',
      },
      {
        language: ' lang="ts"',
        body: `const value: string = tw('p-3');`,
        candidate: 'p-3',
      },
      {
        language: ' lang="tsx"',
        body: `const view: JSX.Element = <div className={tw('p-4')} />;`,
        candidate: 'p-4',
      },
    ];

    for (const fixture of fixtures) {
      const result = transformTwCallsInVueSource({
        source: `<script setup${fixture.language}>
import { tw } from 'virtual:naidan-tailwind';
${fixture.body}
</script>
<template><div /></template>
`,
        filename: 'Fixture.vue',
        additionalImports: [],
      });
      expect(result.code).toContain(JSON.stringify(fixture.candidate));
      expect(result.code).not.toContain("from 'virtual:naidan-tailwind'");
    }
  });

  it('rejects external SFC blocks that cannot receive or expose static Tailwind analysis', () => {
    const externalTemplate = '<template src="./template.html"></template>';
    expect(() => collectTwCandidateOccurrencesFromVueSource({
      source: externalTemplate,
      filename: 'ExternalTemplate.vue',
    })).toThrow(/External Vue template src files are not supported/u);
    expect(() => transformTwCallsInVueSource({
      source: externalTemplate,
      filename: 'ExternalTemplate.vue',
      additionalImports: [],
    })).toThrow(/External Vue template src files are not supported/u);
    expect(() => collectTwCandidateOccurrencesFromVueSource({
      source: '<template lang="pug">div.p-2</template>',
      filename: 'PugTemplate.vue',
    })).toThrow(/Unsupported Vue template language "pug"/u);

    expect(() => transformTwCallsInVueSource({
      source: '<script src="./component.js"></script><template><div tw-class="p-2" /></template>',
      filename: 'ExternalScript.vue',
      additionalImports: ['virtual:naidan-tailwind-css-module/example.js'],
    })).toThrow(/Cannot inject static Tailwind CSS registration imports into an external Vue script src block/u);
  });

  it('rejects unsupported Vue script languages before candidate planning', () => {
    expect(() => transformTwCallsInVueSource({
      source: `<script setup lang="coffee">
value = tw 'p-2'
</script>
<template><div /></template>
`,
      filename: 'Fixture.vue',
      additionalImports: [],
    })).toThrow(/Unsupported Vue script language "coffee"/u);
  });

  it('injects virtual CSS imports in the same TypeScript transform', () => {
    const result = transformTwCallsInModule({
      source: `import { tw } from 'virtual:naidan-tailwind';\nconst value = tw('opacity-50');`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: ['virtual:naidan-tailwind-css/example.css'],
    });
    expect(result.code).toContain('const value = "opacity-50";');
    expect(result.code).toContain('import "virtual:naidan-tailwind-css/example.css";');
    expect(result.map).not.toBeNull();
  });

  it('rejects dynamic and multi-token arguments', () => {
    expect(() => transformTwCallsInModule({
      source: `\
import { tw } from 'virtual:naidan-tailwind';
tw(value);`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    })).toThrow(/exactly one string literal/u);
    expect(() => transformTwCallsInModule({
      source: `\
import { tw } from 'virtual:naidan-tailwind';
tw('flex gap-2');`,
      filename: 'fixture.ts',
      sourceType: 'typescript',
      blockStart: { line: 1, column: 1 },
      additionalImports: [],
    })).toThrow(/exactly one Tailwind class token/u);
  });
});

describe('candidate validation', () => {
  it('rejects a Tailwind runtime version that differs from the exact project pin', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    await expect(createTailwindCandidateValidator({
      projectRoot,
      cssEntryPath: path.join(projectRoot, 'src/style.css'),
      expectedTailwindVersion: '0.0.0',
    })).rejects.toThrow(/Tailwind version mismatch/u);
  });

  it('distinguishes generated utilities, structural markers, and unknown candidates', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const validator = await createTailwindCandidateValidator({
      projectRoot,
      cssEntryPath: path.join(projectRoot, 'src/style.css'),
      expectedTailwindVersion: '4.3.1',
    });
    const result = validator.classify({ candidates: ['flex', 'group/card', 'not-prose', 'bg-reed-500'] });
    expect(result.generatedCandidates).toContain('flex');
    const prefixed = validator.classify({ candidates: ['appearance-none'] });
    expect(prefixed.generatedCss[0]).toContain('-webkit-appearance: none');
    expect(prefixed.generatedCss[0]).toContain('appearance: none');
    expect(result.markerCandidates).toEqual(['group/card', 'not-prose']);
    expect(result.invalidCandidates).toEqual(['bg-reed-500']);
    expect(validator.classify({ candidates: ['flex', 'flex', 'not-prose'] }).candidates).toEqual([
      'flex',
      'not-prose',
    ]);
    expect(() => validator.validate({
      occurrences: [
        { candidate: 'bg-reed-500', filename: 'A.vue', line: 1, column: 2, sourceKind: 'tw-class' },
        { candidate: 'bg-reed-500', filename: 'B.vue', line: 3, column: 4, sourceKind: 'tw()' },
      ],
    })).toThrow(/A\.vue:1:2[\s\S]*B\.vue:3:4/u);
  });
});
