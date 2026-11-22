import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BlockMarkdownRenderer from '@/components/block-markdown/BlockMarkdownRenderer.vue';
import { fileExplorerTextWrap } from '@/features/file-explorer/composables/file-explorer-text-wrap';
import { FILE_EXPLORER_INJECTION_KEY } from '@/features/file-explorer/composables/useFileExplorer';
import type { FileExplorerContext } from '@/features/file-explorer/logic/types';
import { sanitizeHighlightHtml, type AllowedHtml } from '@/logic/security/allowedHtml';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import FileExplorerPreviewPanel from './FileExplorerPreviewPanel.vue';

const source = `\
if (ready) {
  console.log('This line is long enough to wrap inside the preview pane');
}`;

function mountTextPreview({ text, extension, highlightedHtml }: {
  text: string,
  extension: string,
  highlightedHtml: AllowedHtml | undefined,
}) {
  const name = `sample${extension}`;
  const context = {
    previewState: {
      visibility: 'visible',
      entry: {
        path: `/${name}`,
        name,
        kind: 'file',
        size: text.length,
        lastModified: undefined,
        extension,
        mimeCategory: 'text',
        readOnly: false,
        canNavigate: false,
        canMutate: true,
      },
      rawTextContent: text,
      textContent: text,
      highlightedHtml,
      objectUrl: undefined,
      jsonFormatMode: 'formatted',
      loadingState: 'loaded',
      errorMessage: undefined,
      oversized: false,
    },
  } satisfies Pick<FileExplorerContext, 'previewState'>;
  return mount(FileExplorerPreviewPanel, {
    global: { provide: { [FILE_EXPLORER_INJECTION_KEY as symbol]: context } },
  });
}

function mountPreview({ highlightedHtml }: { highlightedHtml: AllowedHtml | undefined }) {
  const wrapper = mountTextPreview({ text: source, extension: '.js', highlightedHtml });
  return {
    toggle: wrapper.get('[data-testid="file-explorer-text-wrap-toggle"]'),
    panel: wrapper.get('[data-testid="preview-panel"]'),
    divider: wrapper.get('[data-testid="preview-resize-handle"]'),
    renderedSource: wrapper.get('[data-testid="file-explorer-preview-text"]'),
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('FileExplorerPreviewPanel text wrapping', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  afterEach(() => {
    fileExplorerTextWrap.value = false;
  });

  it('retains wrapping from plain text into a newly mounted highlighted preview', async () => {
    {
      using plain = mountPreview({ highlightedHtml: undefined });
      expect(plain.toggle.attributes('aria-label')).toBe('Wrap text');
      expect(plain.toggle.attributes('title')).toBe('Wrap text');
      expect(plain.toggle.attributes('aria-pressed')).toBe('false');
      expect(plain.renderedSource.classes()).toContain('whitespace-pre');

      await plain.toggle.trigger('click');
      expect(plain.toggle.attributes('aria-pressed')).toBe('true');
      expect(plain.renderedSource.classes()).toEqual(expect.arrayContaining(['whitespace-pre-wrap', 'wrap-anywhere']));
      expect(plain.renderedSource.element.textContent).toBe(source);
    }

    const highlightedHtml = sanitizeHighlightHtml({ html: `<span class="hljs-keyword">if</span>${source.slice(2)}` });
    using highlighted = mountPreview({ highlightedHtml });
    expect(highlighted.toggle.attributes('aria-pressed')).toBe('true');
    expect(highlighted.renderedSource.classes()).toEqual(expect.arrayContaining(['whitespace-pre-wrap', 'wrap-anywhere']));
    expect(highlighted.renderedSource.get('.hljs-keyword').text()).toBe('if');
    expect(highlighted.renderedSource.element.textContent).toBe(source);

    await highlighted.toggle.trigger('click');
    expect(highlighted.toggle.attributes('aria-pressed')).toBe('false');
    expect(highlighted.renderedSource.classes()).toContain('whitespace-pre');
    expect(highlighted.renderedSource.classes()).not.toContain('whitespace-pre-wrap');
  });

  it('moves the separator with a pointer or the arrow keys and retains the width across panes', async () => {
    const pointer = ({ type, clientX }: { type: string, clientX: number }) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      return event;
    };
    {
      using preview = mountPreview({ highlightedHtml: undefined });
      expect(preview.divider.attributes('aria-valuenow')).toBe('288');
      preview.divider.element.dispatchEvent(pointer({ type: 'pointerdown', clientX: 400 }));
      preview.divider.element.dispatchEvent(pointer({ type: 'pointermove', clientX: 332 }));
      preview.divider.element.dispatchEvent(pointer({ type: 'pointerup', clientX: 332 }));
      await preview.divider.trigger('keydown', { key: 'ArrowRight' });
      expect(preview.panel.attributes('style')).toContain('width: 332px');
    }
    using next = mountPreview({ highlightedHtml: undefined });
    expect(next.divider.attributes('aria-valuenow')).toBe('332');
    await next.divider.trigger('keydown', { key: 'Home' });
    expect(next.divider.attributes('aria-valuenow')).toBe('176');
  });
});

describe('FileExplorerPreviewPanel Markdown rendering', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
  });

  const twoHundredLines = 'Line ending in CRLF\r\n'.repeat(200);
  const longLine = 'a'.repeat(32 * 1024 - 1);

  it.each([
    { name: 'the line limit', text: `${twoHundredLines}Last line`, rendered: twoHundredLines, partial: true },
    { name: 'the character limit', text: `${longLine}🐈Last text`, rendered: longLine, partial: true },
    { name: 'a short file', text: '# Heading', rendered: '# Heading', partial: false },
  ])('limits rendered Markdown for $name and retains the full source', async ({ text, rendered, partial }) => {
    const wrapper = mountTextPreview({ text, extension: '.md', highlightedHtml: undefined });
    using _mounted = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };

    await vi.waitFor(() => expect(wrapper.getComponent(BlockMarkdownRenderer).props('content')).toBe(rendered));
    const notice = wrapper.find('[data-testid="file-explorer-markdown-partial"]');
    expect(notice.exists()).toBe(partial);
    if (partial) {
      expect(notice.text()).toBe('Showing the beginning of this file.');
    }

    await wrapper.get('[data-testid="file-explorer-markdown-source-toggle"]').trigger('click');
    expect(wrapper.findComponent(BlockMarkdownRenderer).exists()).toBe(false);
    expect(wrapper.find('[data-testid="file-explorer-markdown-partial"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="file-explorer-preview-text"]').element.textContent).toBe(text);
  });
});

it.each([
  { label: 'a HEX sample', bytes: new Uint8Array([0xff, 0x41]), partial: true, empty: false },
  { label: 'an empty file', bytes: new Uint8Array(), partial: false, empty: true },
])('can download $label from the right preview', async ({ bytes, partial, empty }) => {
  await ensureAllStringsForTest({ locale: 'en' });
  const downloadEntry = vi.fn<FileExplorerContext['downloadEntry']>();
  const context = {
    downloadEntry,
    previewState: {
      visibility: 'visible',
      entry: {
        path: '/sample.bin',
        name: 'sample.bin',
        kind: 'file',
        size: bytes.length,
        lastModified: undefined,
        extension: '.bin',
        mimeCategory: 'binary',
        readOnly: true,
        canNavigate: false,
        canMutate: false,
      },
      rawTextContent: undefined,
      textContent: undefined,
      highlightedHtml: undefined,
      objectUrl: undefined,
      jsonFormatMode: 'formatted',
      loadingState: 'loaded',
      errorMessage: undefined,
      oversized: false,
      binaryPreview: { bytes, partial },
    },
  } satisfies Pick<FileExplorerContext, 'previewState' | 'downloadEntry'>;
  const wrapper = mount(FileExplorerPreviewPanel, {
    global: { provide: { [FILE_EXPLORER_INJECTION_KEY as symbol]: context } },
  });
  try {
    expect(wrapper.find('[data-testid="preview-empty-file"]').exists()).toBe(empty);
    await wrapper.get('[data-testid="file-explorer-preview-download"]').trigger('click');
    expect(downloadEntry).toHaveBeenCalledExactlyOnceWith({ entry: context.previewState.entry });
  } finally {
    wrapper.unmount();
  }
});
