import { describe, expect, it } from 'vitest';
import type { Effect } from '../contracts/effects.ts';
import { DEFAULT_EFFECT_DEFINITIONS } from '../models/registry.ts';
import { parseVueEventEffects, printVueEventEffects, readVueTemplateEffects } from './vue-template.ts';

const definitions = DEFAULT_EFFECT_DEFINITIONS;

function read({ source }: { source: string }) {
  return readVueTemplateEffects({ source, filename: 'Example.vue', definitions });
}

describe('Vue event effect JSON syntax', () => {
  it('uses the same JSON rows as TypeScript and prints a stable event map', () => {
    const events = parseVueEventEffects({ text: '{"@input":[],"@click":["network.http(*)","opfs.read(*)"]}', definitions });
    expect(events.get('@input')).toEqual([]);
    expect(events.get('@click')?.map(effect => effect.kind === 'operation' ? effect.name : 'call')).toEqual(['network.http', 'opfs.read']);
    expect(printVueEventEffects({ events })).toBe('{"@click":["network.http(*)","opfs.read(*)"],"@input":[]}');
  });

  it.each([
    '[]', 'null', '{"@click":"network.http(*)"}', '{"@click":[1]}', '{"click":[]}', '{"@":[]}',
    '{"@click":["unknown(*)"]}', '{"@click":["none"]}', '{"@click":["network.http(*), opfs.read(*)"]}',
    '{"@click":[],"@click":["network.http(*)"]}', '@click `network.http(*)`',
  ])('rejects invalid map shapes, atoms and superseded syntax: %s', text => {
    expect(() => parseVueEventEffects({ text, definitions })).toThrow();
  });

  it('escapes HTML comment delimiters at the outer JSON layer and preserves resources', () => {
    const effect: Effect = { kind: 'operation', name: 'opfs.read', target: { kind: 'literal', value: 'folder/-->/<!--/data.json' } };
    const events = new Map([['@click', [effect]]]);
    const printed = printVueEventEffects({ events });
    expect(printed).not.toContain('-->');
    expect(printed).not.toContain('<!--');
    expect(parseVueEventEffects({ text: printed, definitions }).get('@click')).toEqual([effect]);
    const contracts = read({ source: '<template><!-- @effects ' + printed + ' --><button @click="send()" /></template>' });
    expect(contracts[0]?.effects).toEqual([effect]);
  });
});

describe('Vue event contract source bindings without SFC effect verification', () => {
  it('associates one comment map with all selected static events on the following element', () => {
    const source = `\
<script setup lang="ts">
const send = () => {};
</script>
<template>
  <!-- @effects {"@click":["network.http(*)"],"@keydown":[]} -->
  <button @click="send()" @keydown.enter="send" />
</template>`;
    const contracts = read({ source });
    expect(contracts.map(contract => contract.event)).toEqual(['@click', '@keydown']);
    const click = contracts[0]!;
    expect(source.slice(click.commentStart, click.commentEnd)).toBe('<!-- @effects {"@click":["network.http(*)"],"@keydown":[]} -->');
    expect(source.slice(click.elementStart, click.elementEnd)).toBe('<button @click="send()" @keydown.enter="send" />');
    expect(click.handlers[0]?.expression).toBe('send()');
    expect(source.slice(click.handlers[0]!.expressionStart!, click.handlers[0]!.expressionEnd!)).toBe('send()');
    expect(contracts[1]?.handlers[0]?.modifiers).toEqual(['enter']);
  });

  it('keeps function references, inline calls and arrows distinct for later semantic analysis', () => {
    const source = `\
<template>
  <!-- @effects {"@click":[]} -->
  <button @click="send" />
  <!-- @effects {"@click":[]} -->
  <button @click="send()" />
  <!-- @effects {"@click":[]} -->
  <button @click="() => send()" />
</template>`;
    expect(read({ source }).map(contract => contract.handlers[0]?.expression)).toEqual(['send', 'send()', '() => send()']);
  });

  it('includes modifier and long-form bindings in the base event contract', () => {
    const source = `\
<template>
  <!-- @effects {"@click":["network.http(*)"]} -->
  <button @click="send()" @click.stop="save()" v-on:click="other()" />
</template>`;
    const contract = read({ source })[0]!;
    expect(contract.handlers.map(handler => handler.expression)).toEqual(['send()', 'save()', 'other()']);
    expect(contract.handlers.map(handler => handler.modifiers)).toEqual([[], ['stop'], []]);
  });

  it('uses original expression ranges when HTML entities change decoded text length', () => {
    const source = '<template><!-- @effects {"@click":[]} --><button @click="send(&quot;x&quot;)" /></template>';
    const handler = read({ source })[0]!.handlers[0]!;
    expect(handler.expression).toBe('send("x")');
    expect(source.slice(handler.expressionStart!, handler.expressionEnd!)).toBe('send(&quot;x&quot;)');
  });

  it('binds comments before v-else and within nested elements using the original AST', () => {
    const source = `\
<template>
  <button v-if="enabled" />
  <!-- @effects {"@click":[]} -->
  <button v-else @click="first()" />
  <section>
    <!-- @effects {"@click":[]} -->
    <button @click="second()" />
  </section>
</template>`;
    expect(read({ source }).map(contract => contract.handlers[0]?.expression)).toEqual(['first()', 'second()']);
  });

  it('ignores comment-like strings and ordinary explanatory comments', () => {
    const source = `\
<script setup lang="ts">
const example = '<!-- @effects {"@missing":[]} -->';
</script>
<template>
  <!-- Explanation containing @effects without a directive prefix. -->
  <button title="&lt;!-- @effects {} --&gt;" @click="send()" />
</template>`;
    expect(read({ source })).toEqual([]);
  });

  it('does not claim that syntax binding resolves a callee or verifies its effect', () => {
    const source = '<template><!-- @effects {"@click":[]} --><button @click="unresolvedFunction()" /></template>';
    expect(read({ source })[0]?.handlers[0]?.expression).toBe('unresolvedFunction()');
  });

  it.each([
    '<template><!-- @effects {"@click":[]} --></template>',
    '<template><!-- @effects {"@click":[]} -->text<button @click="send()" /></template>',
    '<template><!-- @effects {"@click":[]} --><section><button @click="send()" /></section></template>',
    '<template><!-- @effects {"@click":[]} --><!-- @effects {"@click":[]} --><button @click="send()" /></template>',
    '<template><!-- @effects {"@click.stop":[]} --><button @click.stop="send()" /></template>',
    '<template><!-- @effects {"@click":[]} --><button @[event]="send" /></template>',
    '<template><!-- @effects {"@click":[]} --><button v-on="listeners" /></template>',
    '<template><!-- @effects {"@click":[]} --><button @click="send()" @[event]="other" /></template>',
    '<template><!-- @effects {"@click":[]} --><button @click="send()" v-on="listeners" /></template>',
    '<template><!-- @effectsUNKNOWN {"@click":[]} --><button @click="send()" /></template>',
    '<template lang="pug">button(@click="send()")</template>',
    '<template src="./External.html"></template>',
  ])('diagnoses orphan, ambiguous or unsupported annotation bindings: %s', source => {
    expect(() => read({ source })).toThrow();
  });
});
