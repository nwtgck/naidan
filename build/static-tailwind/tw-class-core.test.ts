import path from 'node:path';
import { compile } from '@vue/compiler-dom';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { describe, expect, it } from 'vitest';
import {
  createTwClassNodeTransform,
  parseStaticTwClassExpression,
  transformTwCallsInModule,
  transformTwCallsInVueSource,
} from './tw-class-core.mjs';
import { createTailwindCandidateValidator } from './tailwind-candidate-validator.mjs';

function compileTemplate(template: string): string {
  return compile(template, {
    mode: 'module',
    nodeTransforms: [createTwClassNodeTransform({ filename: 'Fixture.vue' })],
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

  it('rejects unregistered tw-prefixed attributes', () => {
    expect(() => compileTemplate('<div tw-content-class="p-2" />'))
      .toThrow(/Unknown Tailwind class attribute tw-content-class/u);
  });
});

describe('tw macro', () => {
  it('replaces a literal call and removes all compile-time macro imports', () => {
    const result = transformTwCallsInModule({
      source: `\
import { tw, twClasses } from 'virtual:naidan-tailwind';
const value = tw('opacity-50');
`,
      filename: 'fixture.ts',
    });
    expect(result.code).not.toContain('virtual:naidan-tailwind');
    expect(result.code).toContain('const value = "opacity-50";');
    expect(result.occurrences.map(({ candidate }) => candidate)).toEqual(['opacity-50']);
  });


  it('collapses twClassString() to one literal and records every candidate', () => {
    const result = transformTwCallsInModule({
      source: `\
import { twClassString } from 'virtual:naidan-tailwind';
const value = twClassString('rounded-xl', 'dark:border-gray-800');
`,
      filename: 'fixture.ts',
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
    })).toThrow(/one or more string literals/u);
    expect(() => transformTwCallsInModule({
      source: `import { twClassString } from 'virtual:naidan-tailwind'; twClassString(value);`,
      filename: 'fixture.ts',
    })).toThrow(/one or more string literals/u);
    expect(() => transformTwCallsInModule({
      source: `import { twClassString } from 'virtual:naidan-tailwind'; twClassString('flex gap-2');`,
      filename: 'fixture.ts',
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

  it('injects virtual CSS imports in the same TypeScript transform', () => {
    const result = transformTwCallsInModule({
      source: `import { tw } from 'virtual:naidan-tailwind';\nconst value = tw('opacity-50');`,
      filename: 'fixture.ts',
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
    })).toThrow(/exactly one string literal/u);
    expect(() => transformTwCallsInModule({
      source: `\
import { tw } from 'virtual:naidan-tailwind';
tw('flex gap-2');`,
      filename: 'fixture.ts',
    })).toThrow(/exactly one Tailwind class token/u);
  });
});

describe('candidate validation', () => {
  it('distinguishes generated utilities, structural markers, and unknown candidates', async () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const validator = await createTailwindCandidateValidator({
      projectRoot,
      cssEntryPath: path.join(projectRoot, 'src/style.css'),
      expectedTailwindVersion: '4.3.1',
    });
    const result = validator.classify({ candidates: ['flex', 'group/card', 'not-prose', 'bg-reed-500'] });
    expect(result.generatedCandidates).toContain('flex');
    expect(result.markerCandidates).toEqual(['group/card', 'not-prose']);
    expect(result.invalidCandidates).toEqual(['bg-reed-500']);
  });
});
