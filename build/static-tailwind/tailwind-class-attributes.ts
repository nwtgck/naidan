export type TailwindClassAttributeKind =
  | 'sortable-class'
  | 'vue-class'
  | 'vue-transition-class';

export type TailwindClassAttributeDefinition = Readonly<{
  source: string;
  target: string;
  kind: TailwindClassAttributeKind;
}>;

const tailwindClassAttributeDefinitions: readonly TailwindClassAttributeDefinition[] = Object.freeze([
  Object.freeze({ source: 'tw-class', target: 'class', kind: 'vue-class' }),
  Object.freeze({ source: 'tw-enter-from-class', target: 'enter-from-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-enter-active-class', target: 'enter-active-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-enter-to-class', target: 'enter-to-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-appear-from-class', target: 'appear-from-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-appear-active-class', target: 'appear-active-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-appear-to-class', target: 'appear-to-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-leave-from-class', target: 'leave-from-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-leave-active-class', target: 'leave-active-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-leave-to-class', target: 'leave-to-class', kind: 'vue-transition-class' }),
  Object.freeze({ source: 'tw-ghost-class', target: 'ghost-class', kind: 'sortable-class' }),
  Object.freeze({ source: 'tw-chosen-class', target: 'chosen-class', kind: 'sortable-class' }),
  Object.freeze({ source: 'tw-drag-class', target: 'drag-class', kind: 'sortable-class' }),
  Object.freeze({ source: 'tw-fallback-class', target: 'fallback-class', kind: 'sortable-class' }),
]);

export const tailwindClassAttributeBySource = new Map<string, TailwindClassAttributeDefinition>(
  tailwindClassAttributeDefinitions.map((definition) => [definition.source, definition]),
);
