import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileStyle, parse } from '@vue/compiler-sfc';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import postcss from 'postcss';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import WorkflowPage from '../pages/workflow/index.vue';
import { messages as english } from '../pages/workflow/messages/en';
import { messages as japanese } from '../pages/workflow/messages/ja';
import { createWorkflowGuideExample } from '../pages/workflow/example';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';
import { validateDocsAuthoringSource } from '../build/authoring-policy';

describe('Workflow guide', () => {
  it('keeps the static article and its sample inside the Docs authoring boundary', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    for (const filename of ['pages/workflow/index.vue', 'pages/workflow/example.ts', 'pages/workflow/messages/en.tsx', 'pages/workflow/messages/ja.tsx', 'components/demos/WorkflowGuideStep.vue', 'components/demos/WorkflowFlowDiagram.vue']) {
      await expect(validateDocsAuthoringSource({
        source: readFileSync(path.join(root, filename), 'utf8'),
        filename,
        root,
        resolve: async ({ specifier, importer }) => specifier.startsWith('.') ? path.resolve(path.dirname(importer), specifier) : undefined,
      })).resolves.toBeUndefined();
    }
  });

  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('ships the complete create, run, inspect and reuse path in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(WorkflowPage, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-workflow"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('[data-docs-app-entry-path]')?.getAttribute('data-docs-app-entry-path')).toBe('/#/workflows');
    expect([...article?.querySelectorAll('section.workflow-step h2') ?? []].map(node => node.textContent)).toEqual([
      s.build_title, s.connection_title, s.run_title, s.results_title, s.reuse_title,
    ]);
    expect([...article?.querySelectorAll('[data-docs-animation]') ?? []].map(node => node.getAttribute('data-docs-animation'))).toEqual([
      'workflow-flow', 'workflow-edit', 'workflow-connection', 'workflow-run', 'workflow-results', 'workflow-reuse',
    ]);
    expect(article?.querySelector('[data-testid="workflow-reference"]')?.textContent).toContain(`${s.summary_name} · text`);
    expect(article?.querySelector('[data-docs-animation="workflow-connection"]')?.textContent).toContain('http://localhost:11434');
    const labels = locale === 'en'
      ? { graph: 'Dependencies', model: 'Model connection', output: 'Output', stop: 'Stop generation' }
      : { graph: '依存関係', model: 'モデル接続', output: '出力', stop: '生成を停止' };
    expect(article?.querySelector('[data-testid="workflow-dependencies-tab"]')?.textContent).toBe(labels.graph);
    expect(article?.querySelector('[data-testid="workflow-model-heading"]')?.textContent).toBe(labels.model);
    expect([...article?.querySelectorAll('[data-testid="workflow-output-label"]') ?? []].map(node => node.textContent)).toEqual([labels.output, labels.output, labels.output]);
    expect([...article?.querySelectorAll('[aria-labelledby="workflow-connection"] > p .ui-label') ?? []].map(node => node.textContent)).toContain(labels.model);
    expect([...article?.querySelectorAll('[aria-labelledby="workflow-results"] > p .ui-label') ?? []].map(node => node.textContent)).toContain(labels.output);
    for (const stage of ['run', 'reuse']) {
      const scene = article?.querySelector(`[data-docs-animation="workflow-${stage}"]`);
      const start = scene?.querySelector('[data-testid="workflow-start-action"]');
      const stop = scene?.querySelector('[data-testid="workflow-stop-action"]');
      expect(start?.classList.contains('before-start')).toBe(true);
      expect(stop?.classList.contains('after-start')).toBe(true);
      expect(stop?.textContent).toBe(labels.stop);
      expect(stop?.querySelector('[data-testid="workflow-stop-icon"] rect')).not.toBeNull();
      expect(stop?.hasAttribute('disabled')).toBe(false);
      expect(stop?.getAttribute('aria-disabled')).not.toBe('true');
      expect(scene?.querySelector('[data-testid="workflow-execution-pane"]')?.classList.contains('after-start')).toBe(true);
    }
    for (const stage of ['edit', 'connection', 'results']) {
      const scene = article?.querySelector(`[data-docs-animation="workflow-${stage}"]`);
      expect(scene?.querySelector('[data-testid="workflow-stop-action"]')).toBeNull();
      expect(scene?.querySelector('[data-testid="workflow-start-action"]')?.classList.contains('before-start')).toBe(false);
    }
    expect(article?.querySelector('[data-docs-animation="workflow-run"] [data-testid="workflow-input-text"]')?.textContent).toBe(s.notes_example);
    expect(article?.querySelector('[data-docs-animation="workflow-reuse"] [data-testid="workflow-input-text"]')?.textContent).toBe(s.next_notes_example);
    expect([...article?.querySelectorAll('[data-testid="workflow-output-card"] p') ?? []].map(node => node.textContent)).toEqual([
      s.notes_example, s.summary_example, s.share_example,
    ]);
    expect(article?.querySelectorAll('figure button, figure input, figure textarea, figure [tabindex], figure a')).toHaveLength(0);
    expect(article?.querySelector('a[href$="/endpoint-type-ollama/"]')?.getAttribute('href')).toBe(`/docs/${locale}/endpoint-type-ollama/`);
    expect(article?.querySelector('a[href$="/data-storage/"]')?.getAttribute('href')).toBe(`/docs/${locale}/data-storage/`);

    // The optional sample is an actual editable definition, using the same
    // instructions and output names as the hand-entry path above.
    const sample = article?.querySelector('[data-testid="workflow-example-json"]')?.textContent;
    expect(sample).toBeTruthy();
    // Load app code only inside this parser check. A static import would make
    // the isolated Docs type check traverse the application's dependency graph.
    const repository = fileURLToPath(new URL('../..', import.meta.url));
    const server = await createServer({
      configFile: false,
      root: repository,
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, ws: false },
      resolve: { alias: { '@': path.join(repository, 'src') } },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await using _cleanup = { [Symbol.asyncDispose]: () => server.close() };
    const parser: unknown = await server.ssrLoadModule('/src/00-storage/service/workflow-json.ts');
    const validator: unknown = await server.ssrLoadModule('/src/features/workflow/logic/definition.ts');
    if (typeof parser !== 'object' || parser === null
      || !('parseWorkflowDefinition' in parser) || typeof parser.parseWorkflowDefinition !== 'function'
      || !('formatWorkflowDefinition' in parser) || typeof parser.formatWorkflowDefinition !== 'function'
      || typeof validator !== 'object' || validator === null
      || !('validateWorkflow' in validator) || typeof validator.validateWorkflow !== 'function') {
      throw new Error('The app must export its workflow parser, formatter and validator.');
    }
    const definition: unknown = parser.parseWorkflowDefinition({ text: sample ?? '' });
    expect(validator.validateWorkflow({ definition })).toEqual([]);
    const formatted: unknown = parser.formatWorkflowDefinition({ definition });
    if (typeof formatted !== 'string') {
      throw new Error('The app workflow formatter must return JSON text.');
    }
    expect(parser.parseWorkflowDefinition({ text: formatted })).toEqual(definition);
    expect(definition).toMatchObject({
      name: s.example_name,
      steps: [
        { id: 'meeting-notes', type: 'request_input', prompt: { type: 'literal', value: s.input_prompt }, responseType: 'text' },
        ...[
          { id: 'three-points', name: s.summary_name, producer: 'meeting-notes', output: 'value', instruction: s.summary_instruction },
          { id: 'team-update', name: s.share_name, producer: 'three-points', output: 'text', instruction: s.share_instruction },
        ].map(({ id, name, producer, output, instruction }) => ({
          id,
          name,
          type: 'text_generation',
          appendMessages: [{
            role: 'user',
            parts: [
              { type: 'text', text: instruction },
              { type: 'value', value: { type: 'step_output', stepId: producer, output } },
            ],
          }],
          target: { type: 'model', endpoint: { type: 'ollama', url: 'http://localhost:11434', httpHeaders: undefined }, modelId: 'qwen3:8b' },
          conversation: { type: 'conversation', messages: [] },
          toolConfigs: [],
        })),
      ],
    });
    expect(JSON.parse(sample ?? '')).toEqual(createWorkflowGuideExample({ messages: s }));
  });

  it('keeps camera focus and final readable content when motion is disabled', () => {
    const filename = new URL('../components/demos/WorkflowGuideStep.vue', import.meta.url).pathname;
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename });
    expect(errors).toHaveLength(0);
    const compiled = compileStyle({ source: descriptor.styles[0]?.content ?? '', filename, id: 'data-v-workflow-test', scoped: true });
    expect(compiled.errors).toHaveLength(0);
    const css = postcss.parse(compiled.code);
    const paused: string[] = [], reduced: string[] = [];
    css.walkRules(rule => {
      const declarations = rule.nodes.flatMap(node => node.type === 'decl' ? [`${node.prop}:${node.value}${node.important ? '!important' : ''}`] : []);
      if (rule.selector.includes('#docs-pause-motion:checked')) {
        expect(rule.selector).toMatch(/^html:has\(#docs-pause-motion:checked\)/);
        expect(rule.selector).toContain('[data-v-workflow-test]');
        paused.push(...declarations);
      }
      if (rule.parent?.type === 'atrule' && rule.parent.params.includes('prefers-reduced-motion')) {
        reduced.push(...declarations);
      }
    });
    for (const declarations of [paused, reduced]) {
      expect(declarations).toContain('animation:none!important');
      expect(declarations).toContain('display:none');
    }
    // Run disappears at the same moment that Stop and the pending-input pane
    // appear. The click pointer precedes this transition on both run scenes.
    const visibilityAt = ({ name, percent }: { name: string; percent: number }): string | undefined => {
      const frames: { percent: number; visibility: string }[] = [];
      css.walkAtRules('keyframes', keyframes => {
        if (keyframes.params !== name && !keyframes.params.startsWith(`${name}-`)) {
          return;
        }
        keyframes.walkRules(frame => {
          frame.walkDecls('visibility', declaration => {
            for (const offset of frame.selector.split(',')) {
              frames.push({ percent: Number.parseFloat(offset), visibility: declaration.value });
            }
          });
        });
      });
      return frames.sort((left, right) => left.percent - right.percent).filter(frame => frame.percent <= percent).at(-1)?.visibility;
    };
    for (const stage of ['run', 'reuse']) {
      for (const phase of ['before', 'after']) {
        const animations: string[] = [];
        css.walkRules(rule => {
          if (rule.selector.includes(`.stage-${stage} .${phase}-start`)) {
            rule.walkDecls('animation', declaration => {
              animations.push(declaration.value);
            });
          }
        });
        expect(animations).toHaveLength(1);
        expect(animations[0]?.startsWith(`workflow-${phase}-start-`)).toBe(true);
        expect(animations[0]).toContain('12s steps(1,end) infinite');
      }
    }
    for (const percent of [0, 12, 17, 18, 50, 95]) {
      expect({
        run: visibilityAt({ name: 'workflow-before-start', percent }),
        stopAndInput: visibilityAt({ name: 'workflow-after-start', percent }),
      }).toEqual(percent < 18 ? { run: 'visible', stopAndInput: 'hidden' } : { run: 'hidden', stopAndInput: 'visible' });
    }
    const restingVisibility = new Map<string, string>();
    css.walkRules(rule => {
      if (rule.parent?.type === 'root' && ['.before-start[data-v-workflow-test]', '.after-start[data-v-workflow-test]'].includes(rule.selector)) {
        rule.walkDecls('visibility', declaration => {
          restingVisibility.set(rule.selector, declaration.value);
        });
      }
    });
    expect(restingVisibility.get('.before-start[data-v-workflow-test]')).toBe('hidden');
    expect(restingVisibility.get('.after-start[data-v-workflow-test]')).toBe('visible');
    // Final poses are normal styles, so disabling animation keeps the input,
    // reference and complete result text readable.
    const source = descriptor.styles[0]?.content ?? '';
    expect(source).toMatch(/\.editor-canvas\s*\{[^}]*transform:\s*translate\(var\(--editor-x\),\s*var\(--editor-y\)\)/);
    expect(source).toMatch(/\.app-canvas\s*\{[^}]*transform:\s*translate\(var\(--result-x\),\s*var\(--run-y\)\)/);
    // Horizontal focus follows the actual figure width, including widths just
    // above a media breakpoint where the surrounding article is narrower.
    expect(source).toContain('container-type: inline-size');
    expect(source).toContain('--focus-width: min(420px, calc(100cqw - 2px))');
    expect(source).toContain('--editor-x: min(-90px, calc(100cqw - 432px - var(--focus-width)))');
    expect(source).toContain('--result-x: min(0px, calc(100cqw - 152px - var(--focus-width)))');
    expect(source).not.toContain('scale(');
    expect(source).not.toMatch(/\.camera\s*\{[^}]*height:\s*auto/);
  });
});
