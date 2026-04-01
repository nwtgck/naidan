/**
 * Tests that trailingInline is correctly propagated to the last visible
 * character of every block token type that contains nested children.
 *
 * Each test mounts BlockMarkdownRenderer with a stub trailingInline component
 * and asserts that exactly one indicator is present at the right location.
 */

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h, defineComponent, markRaw } from 'vue';
import BlockMarkdownRenderer from './BlockMarkdownRenderer.vue';

const TrailingStub = defineComponent({
  name: 'TrailingStub',
  render() {
    return h('span', { 'data-testid': 'trailing-stub' });
  },
});

const mountRenderer = ({ content }: { content: string }) =>
  mount(BlockMarkdownRenderer, {
    props: { content, trailingInline: markRaw(TrailingStub) },
  });

describe('BlockMarkdownRenderer trailingInline propagation', () => {
  describe('paragraph (baseline)', () => {
    it('renders indicator after paragraph text', () => {
      const wrapper = mountRenderer({ content: 'Hello world' });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const p = wrapper.find('p');
      expect(p.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });
  });

  describe('list', () => {
    it('renders indicator after the last item of a bulleted list', () => {
      const wrapper = mountRenderer({ content: `\
* item 1
* item 2
* item 3
` });
      // Exactly one indicator
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      // Should be inside the last <li>
      const items = wrapper.findAll('li');
      expect(items[items.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
      // Not inside earlier items
      expect(items[0]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });

    it('renders indicator after the last item of an ordered list', () => {
      const wrapper = mountRenderer({ content: `\
1. first
2. second
` });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const items = wrapper.findAll('li');
      expect(items[items.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });

    it('renders indicator after the last item of a task list', () => {
      const wrapper = mountRenderer({ content: `\
* [ ] todo
* [x] done
` });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const items = wrapper.findAll('li');
      expect(items[items.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
      expect(items[0]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });

    it('does not render indicator in earlier list items', () => {
      const wrapper = mountRenderer({ content: `\
* alpha
* beta
* gamma
` });
      const items = wrapper.findAll('li');
      expect(items[0]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
      expect(items[1]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
      expect(items[2]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });
  });

  describe('blockquote', () => {
    it('renders indicator inside a blockquote after its last content', () => {
      const wrapper = mountRenderer({ content: '> quoted text' });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const bq = wrapper.find('blockquote');
      expect(bq.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });

    it('renders indicator after the last paragraph of a multi-paragraph blockquote', () => {
      const wrapper = mountRenderer({ content: `\
> line one
>
> line two
` });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const bq = wrapper.find('blockquote');
      const paras = bq.findAll('p');
      expect(paras[paras.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
      expect(paras[0]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });
  });

  describe('table', () => {
    it('renders indicator in the last non-empty cell of the last row', () => {
      const wrapper = mountRenderer({ content: `\
| A | B |
|---|---|
| 1 | 2 |
| 3 | 4 |
` });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const rows = wrapper.findAll('tbody tr');
      const lastRow = rows[rows.length - 1]!;
      const cells = lastRow.findAll('td');
      // Indicator in the last non-empty cell of the last row
      expect(cells[cells.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
      // Not in earlier cells
      expect(cells[0]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });

    it('skips trailing empty cells and places indicator in the last cell with content', () => {
      // Simulate streaming state: last row has an empty trailing cell (not yet filled)
      const wrapper = mountRenderer({ content: `\
| A | B | C |
|---|---|---|
| x | y |   |
` });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const cells = wrapper.findAll('tbody td');
      // Cell 0="x", cell 1="y", cell 2="" — indicator goes to cell 1
      expect(cells[1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
      expect(cells[0]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
      expect(cells[2]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });

    it('does not render indicator in earlier rows', () => {
      const wrapper = mountRenderer({ content: `\
| X |
|---|
| row1 |
| row2 |
` });
      const rows = wrapper.findAll('tbody tr');
      expect(rows[0]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
      expect(rows[rows.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });
  });

  describe('mixed: last block determines where indicator appears', () => {
    it('paragraph then list — indicator is in the list', () => {
      const wrapper = mountRenderer({ content: `\
Intro paragraph.

* item 1
* item 2
` });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const p = wrapper.find('p');
      expect(p.find('[data-testid="trailing-stub"]').exists()).toBe(false);
      const items = wrapper.findAll('li');
      expect(items[items.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });

    it('list then paragraph — indicator is in the paragraph', () => {
      const wrapper = mountRenderer({ content: `\
* item 1
* item 2

Closing paragraph.
` });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(1);
      const paras = wrapper.findAll('p');
      expect(paras[paras.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(true);
      const items = wrapper.findAll('li');
      expect(items[items.length - 1]!.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });
  });

  describe('no trailingInline', () => {
    it('renders normally without trailingInline prop', () => {
      const wrapper = mount(BlockMarkdownRenderer, {
        props: { content: `\
* item 1
* item 2
` },
      });
      expect(wrapper.findAll('[data-testid="trailing-stub"]')).toHaveLength(0);
      expect(wrapper.findAll('li')).toHaveLength(2);
    });
  });
});
