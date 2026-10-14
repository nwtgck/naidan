import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { compileStyle, parse as parseSfc } from '@vue/compiler-sfc';
import { parse as parseCss } from 'postcss';
import { JSDOM } from 'jsdom';
import ShellGuide from '../pages/tool-browser-shell/index.vue';
import ShellWorkspaceDemo from '../site/demos/ShellWorkspaceDemo.vue';
import { strings as english } from '../pages/tool-browser-shell/strings/en';
import { strings as japanese } from '../pages/tool-browser-shell/strings/ja';
import { strings as englishCommon } from '../strings/common/en';
import { strings as japaneseCommon } from '../strings/common/ja';

const editions = [
  { locale: 'en', strings: english, common: englishCommon },
  { locale: 'ja', strings: japanese, common: japaneseCommon },
] as const;

describe('shell guide tool-call demonstration', () => {
  it.each(editions)('shows the Chat Tools and Shell switch walkthrough before the longer guide in $locale', async ({ locale, strings, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(ShellGuide, { s: strings, locale, common }) }));
    using page = {
      window: new JSDOM(html).window,
      [Symbol.dispose]() {
        this.window.close();
      },
    };
    const document = page.window.document;
    const walkthrough = document.querySelector('[data-testid="docs-shell-walkthrough"]');
    expect(document.querySelector('[data-docs-app-entry-path]')?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    const modelEntry = document.querySelector('.prerequisite [data-docs-app-entry-path]');
    const modelPath = modelEntry?.getAttribute('data-docs-app-entry-path') ?? '';
    expect(modelEntry?.textContent).toContain('Qwen3.5 9B');
    expect(modelPath).toMatch(/^\/#\/\?/);
    expect(new URLSearchParams(modelPath.split('?')[1]).get('llama-cpp-browser-model')).toBe('hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M');
    const open = walkthrough?.querySelector('[data-testid="docs-shell-enable-open"]');
    const enable = walkthrough?.querySelector('[data-testid="docs-shell-enable-enable"]');
    expect(walkthrough?.previousElementSibling?.querySelector('[data-testid="docs-shell-demo"]')).not.toBeNull();
    expect([...walkthrough?.querySelectorAll('figure') ?? []]).toHaveLength(2);
    expect(open?.getAttribute('data-docs-animation')).toBe('shell-enable-open');
    expect(enable?.getAttribute('data-docs-animation')).toBe('shell-enable-enable');
    expect(open?.textContent).toContain(strings.walkthrough.demo.optionsTools);
    expect(open?.querySelector('[data-testid="docs-shell-tools-trigger"]')).not.toBeNull();
    expect(enable?.querySelector('[data-testid="docs-shell-switch"]')?.textContent).toContain(strings.walkthrough.demo.on);
    expect(enable?.querySelector('[data-testid="docs-shell-settings-result"]')?.textContent).toContain(strings.walkthrough.demo.shellSettings);
    expect(enable?.textContent).toContain('/sys/fs/naidan');
    expect(walkthrough?.querySelectorAll('.ui-label').length).toBeGreaterThan(4);
    expect([...walkthrough?.querySelectorAll('a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/wesh-sysfs/`, `/docs/${locale}/file-access/`,
    ]);
    expect(walkthrough?.textContent).toContain(strings.walkthrough.use.filesLink);
    expect(walkthrough?.querySelector('button, input, textarea, [tabindex], script')).toBeNull();
  });

  it.each(editions)('renders a coherent five-call file task and complete transcript in $locale', async ({ locale, strings, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(ShellGuide, { s: strings, locale, common }) }));
    using page = {
      window: new JSDOM(html).window,
      [Symbol.dispose]() {
        this.window.close();
      },
    };
    const document = page.window.document;
    const demo = document.querySelector('[data-testid="docs-shell-demo"]');
    const calls = [...demo?.querySelectorAll('[data-testid="docs-shell-call"]') ?? []];
    expect(calls.map(call => call.getAttribute('data-shell-call'))).toEqual(['git', 'grep', 'sed', 'write', 'review']);
    const scripts = calls.map(call => call.querySelector('[data-testid="docs-shell-command"] code')?.textContent);
    expect(scripts.slice(0, 3)).toEqual([
      'git -C /home/user/project status --short',
      "grep -n 'TODO' /home/user/project/notes.md",
      "sed -n '1,8p' /home/user/project/notes.md",
    ]);
    for (const [index, call] of calls.entries()) {
      expect(call.getAttribute('data-tool-name')).toBe('shell_execute');
      expect(JSON.parse(call.getAttribute('data-tool-arguments') ?? '{}')).toEqual({ shell_script: scripts[index] });
    }
    const [firstNote, secondNote] = strings.demo.noteLines;
    if (firstNote === undefined || secondNote === undefined) throw new Error('The example requires two project notes');
    const summary = ['# ' + strings.demo.summaryTitle, '', '- ' + firstNote, '- ' + secondNote, ''].join('\n');
    expect(scripts[3]).toBe(['cat <<EOF > /home/user/project/task-summary.md', summary.trimEnd(), 'EOF', ''].join('\n'));
    expect(scripts[4]).toBe(['cat /home/user/project/task-summary.md', 'git -C /home/user/project status --short'].join('\n'));
    const results = calls.map(call => call.querySelector('[data-testid="docs-shell-result"]')?.textContent);
    expect(results[0]).toBe('Exit Code: 0\n');
    expect(results[3]).toBe('Exit Code: 0\n');
    expect(results[1]).toBe(['Exit Code: 0', '', 'STDOUT:', '3:TODO: ' + firstNote, '7:TODO: ' + secondNote, '', ''].join('\n'));
    expect(results[2]).toContain(strings.demo.reviewNote);
    expect(results[4]).toBe(['Exit Code: 0', '', 'STDOUT:', summary + '?? task-summary.md\n', ''].join('\n'));
    const finalScene = demo?.querySelector('[data-shell-step="review"] [data-testid="docs-shell-sequence"]');
    expect(finalScene?.querySelectorAll('[data-testid="docs-shell-history"]')).toHaveLength(4);
    expect(finalScene?.textContent).toContain(strings.demo.sequenceSummaries.review);
    expect(demo?.textContent).toContain(strings.demo.prompt);
    const answer = demo?.querySelector('[data-testid="docs-shell-response"]');
    expect(answer?.textContent).toContain(strings.demo.responseLead);
    for (const item of strings.demo.responseItems) expect(answer?.textContent).toContain(item);
    expect(document.querySelector('figcaption')?.textContent).toBe(strings.diagramCaption);

    const transcript = document.querySelector('[data-testid="docs-shell-transcript"]');
    expect(transcript?.querySelector('summary')?.textContent).toContain(strings.demo.transcriptTitle);
    expect(transcript?.closest('[aria-hidden="true"]')).toBeNull();
    expect(transcript?.querySelectorAll('section')).toHaveLength(5);
    for (const script of scripts) expect(transcript?.textContent).toContain(script);
    for (const result of results) expect(transcript?.textContent).toContain(result);
    expect(transcript?.textContent).toContain(strings.demo.responseLead);
    expect(transcript?.querySelector('[aria-live]')).toBeNull();
    const commands = document.querySelector('[data-testid="docs-shell-command-list"]');
    expect(commands?.querySelectorAll(':scope > li')).toHaveLength(6);
    expect([...commands?.querySelectorAll('code') ?? []].map(element => element.textContent)).toEqual(english.commands.flatMap(group => group.names));

    // The animated replica is presentation only; its transcript is a native disclosure.
    expect(demo?.getAttribute('aria-hidden')).toBe('true');
    expect(demo?.getAttribute('data-docs-animation')).toBe('shell-tool-call');
    expect(demo?.querySelector('button, input, textarea, [tabindex], script')).toBeNull();
  });

  it('preserves long Japanese text and unbroken file content in every result and the transcript', async () => {
    const longNote = '資料の内容と担当者を確認してから会場と参加者への連絡方法を決める。'.repeat(20);
    const unbrokenNote = 'project_notes_'.repeat(80);
    const copy = {
      ...japanese.demo,
      title: longNote,
      prompt: longNote,
      noteLines: [longNote, unbrokenNote],
      responseLead: longNote,
      responseItems: [longNote, unbrokenNote],
    };
    const html = await renderToString(createSSRApp({ render: () => h(ShellWorkspaceDemo, { copy, chrome: japaneseCommon.chrome }) }));
    using page = {
      window: new JSDOM(html).window,
      [Symbol.dispose]() {
        this.window.close();
      },
    };
    const document = page.window.document;
    for (const id of ['grep', 'sed', 'review']) {
      const result = document.querySelector('[data-shell-call="' + id + '"] [data-testid="docs-shell-result"]');
      expect(result?.textContent).toContain(longNote);
      expect(result?.textContent).toContain(unbrokenNote);
    }
    const answer = document.querySelector('[data-testid="docs-shell-response"]');
    expect([...answer?.querySelectorAll('li') ?? []].map(element => element.textContent)).toEqual(copy.responseItems);
    const transcript = document.querySelector('[data-testid="docs-shell-transcript"]');
    expect(transcript?.textContent).toContain(longNote);
    expect(transcript?.textContent).toContain(unbrokenNote);
  });

  it.each(['pause', 'reduced'] as const)('shows the completed review and answer when motion is %s', async mode => {
    const html = await renderToString(createSSRApp({ render: () => h(ShellWorkspaceDemo, { copy: english.demo, chrome: englishCommon.chrome }) }));
    const source = await readFile(new URL('../site/demos/ShellWorkspaceDemo.vue', import.meta.url), 'utf8');
    const { descriptor } = parseSfc(source);
    const style = descriptor.styles[0];
    if (!style) throw new Error('Missing Shell demo style');
    const scopeId = 'data-v-shell-motion-test';
    const compiled = compileStyle({ source: style.content, filename: 'ShellWorkspaceDemo.vue', id: scopeId, scoped: true });
    expect(compiled.errors).toEqual([]);
    const reducedRules: string[] = [];
    parseCss(compiled.code).walkAtRules('media', rule => {
      if (rule.params.includes('prefers-reduced-motion')) reducedRules.push(...(rule.nodes?.map(node => node.toString()) ?? []));
    });
    using page = {
      window: new JSDOM(`<!doctype html><html><head></head><body><input id="docs-pause-motion" type="checkbox">${html}</body></html>`).window,
      [Symbol.dispose]() {
        this.window.close();
      },
    };
    const { document } = page.window;
    const demo = document.querySelector('[data-testid="docs-shell-demo"]');
    if (!demo) throw new Error('Missing Shell demo');
    for (const element of [demo, ...demo.querySelectorAll('*')]) element.setAttribute(scopeId, '');
    const sheet = document.createElement('style');
    sheet.textContent = compiled.code + (mode === 'reduced' ? `\n${reducedRules.join('\n')}` : '');
    document.head.append(sheet);
    if (mode === 'pause') document.querySelector<HTMLInputElement>('#docs-pause-motion')!.checked = true;

    const isVisible = ({ selector }: { selector: string }): boolean => {
      const element = demo.querySelector(selector);
      if (!element) throw new Error(`Missing Shell demo element: ${selector}`);
      for (let current: Element | null = element; current && current !== demo.parentElement; current = current.parentElement) {
        const computed = page.window.getComputedStyle(current);
        if (computed.display === 'none' || computed.visibility === 'hidden' || computed.opacity === '0') return false;
      }
      return true;
    };

    for (const selector of [
      '.shell-stage-grid',
      '[data-shell-step="review"]',
      '[data-shell-step="review"] .draft-variant',
      '[data-shell-step="review"] .execution-variant',
      '[data-shell-step="review"] [data-testid="docs-shell-result"]',
      '[data-testid="docs-shell-response"]',
    ]) {
      const element = demo.querySelector(selector);
      if (!element) throw new Error(`Missing Shell demo element: ${selector}`);
      expect(page.window.getComputedStyle(element).animation, selector).toBe('none');
    }

    for (const selector of [
      '[data-shell-step="review"]',
      '[data-shell-step="review"] .execution-variant',
      '[data-shell-step="review"] .tool-complete',
      '[data-shell-step="review"] [data-testid="docs-shell-result"]',
      '[data-testid="docs-shell-response"]',
    ]) expect(isVisible({ selector }), selector).toBe(true);
    for (const selector of [
      '[data-shell-step="git"]',
      '[data-shell-step="review"] .draft-variant',
      '[data-shell-step="review"] .tool-executing',
      '[data-shell-step="review"] .live-output',
      '.initial-summary',
      '.demo-pointer',
    ]) expect(isVisible({ selector }), selector).toBe(false);
    expect(demo.querySelector('[data-shell-step="review"] [data-testid="docs-shell-result"]')?.textContent).toContain('STDOUT:');
    expect(demo.querySelector('[data-testid="docs-shell-response"]')?.textContent).toContain(english.demo.responseLead);
  });

  it('reserves intrinsic scene sizes and animates no layout properties', async () => {
    // This verifies the scaffold and CSS contract, not browser pixel layout.
    const source = await readFile(new URL('../site/demos/ShellWorkspaceDemo.vue', import.meta.url), 'utf8');
    const { descriptor } = parseSfc(source);
    const css = parseCss(descriptor.styles.map(style => style.content).join('\n'));
    const animatedProperties = new Set<string>();
    let gridHost = false, overlay = false, duration = 0, writingEnd = 0;
    css.walkRules(rule => {
      if (rule.parent?.type === 'atrule' && rule.parent.name === 'keyframes') {
        rule.walkDecls(declaration => {
          animatedProperties.add(declaration.prop);
        });
        return;
      }
      rule.walkDecls(declaration => {
        if (rule.selector === '.shell-stage-grid,.stage-layer' && declaration.prop === 'display' && declaration.value === 'grid') gridHost = true;
        if (rule.selector === '.stage-layer' && declaration.prop === 'grid-area' && declaration.value === '1/1') overlay = true;
        if (declaration.prop === '--shell-cycle') duration = Number.parseFloat(declaration.value);
      });
    });
    css.walkAtRules('keyframes', rule => {
      if (rule.params !== 'shell-script') return;
      rule.walkRules(frame => {
        frame.walkDecls('clip-path', declaration => {
          if (declaration.value === 'inset(0)') writingEnd = Math.min(...frame.selector.split(',').map(value => Number.parseFloat(value)));
        });
      });
    });
    expect(gridHost && overlay).toBe(true);
    expect([...animatedProperties].every(property => ['opacity', 'visibility', 'transform', 'clip-path'].includes(property))).toBe(true);
    expect(duration * writingEnd / 100).toBeGreaterThan(0);
    expect(duration * writingEnd / 100).toBeLessThan(1);

    // Scoped compilation renames keyframes; each stage must still reference its owner.
    const compiled = compileStyle({ source: descriptor.styles.map(style => style.content).join('\n'), filename: 'ShellWorkspaceDemo.vue', id: 'data-v-shell-test', scoped: true });
    expect(compiled.errors).toEqual([]);
    const compiledCss = parseCss(compiled.code);
    const frameNames = new Set<string>();
    compiledCss.walkAtRules('keyframes', rule => {
      frameNames.add(rule.params);
    });
    const stageAnimationNames: string[] = [];
    compiledCss.walkRules(rule => {
      if (!/^\.stage-(one|two|three|four|five)\[[^\]]+\]$/u.test(rule.selector)) return;
      rule.walkDecls('animation-name', declaration => {
        stageAnimationNames.push(declaration.value);
      });
    });
    expect(new Set(stageAnimationNames).size).toBe(5);
    expect(stageAnimationNames.every(name => frameNames.has(name))).toBe(true);
  });
});
