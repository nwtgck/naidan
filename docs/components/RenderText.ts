import type { VNode } from 'vue';

export default function RenderText({ node }: { node: VNode }): VNode {
  return node;
}
