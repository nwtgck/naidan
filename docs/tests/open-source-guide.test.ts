import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { messages as en } from '../pages/open-source/messages/en';
import { messages as ja } from '../pages/open-source/messages/ja';
import { createSiteFixture, parsePage } from './site.test-support';

describe('open source and releases guide', () => {
  it('renders both languages with public source, workflow, release, and license paths', async () => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });

    for (const [locale, copy] of [['en', en], ['ja', ja]] as const) {
      const html = await readFile(path.join(fixture.docs, 'dist', locale, 'open-source/index.html'), 'utf8');
      using page = parsePage({ html });
      const article = page.document.querySelector('[data-testid="docs-open-source"]');
      expect(page.document.documentElement.lang).toBe(locale);
      expect(article?.querySelector('h1')?.textContent).toBe(copy.title);
      const intro = article?.querySelector('.lead');
      const repository = article?.querySelector('#open-source-repository')?.closest('section');
      expect(intro?.textContent).toBe(copy.introduction);
      expect(intro?.nextElementSibling).toBe(repository);
      const repositoryLink = repository?.querySelector('a[data-docs-external]');
      expect(repositoryLink?.getAttribute('href')).toBe('https://github.com/nwtgck/naidan');
      expect([...(repositoryLink?.childNodes ?? [])].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim()).toBe('https://github.com/nwtgck/naidan');
      expect(Array.from(article?.querySelectorAll('h2') ?? []).map(heading => heading.textContent)).toEqual([
        copy.repository_title,
        copy.license_title,
        copy.source_title,
        copy.build_title,
        copy.use_title,
      ]);
      expect(article?.textContent).toContain(copy.build_note);
      expect(article?.textContent).toContain(copy.use_self_build_body);
      expect(article?.querySelectorAll('.open-source-flow li')).toHaveLength(3);
      expect(article?.querySelectorAll('.pair-grid .panel')).toHaveLength(2);
      expect(article?.querySelector('[data-docs-related-guide] a')?.getAttribute('href')).toBe(`/docs/${locale}/standalone/`);

      const links = [...(article?.querySelectorAll<HTMLAnchorElement>('a[data-docs-external]') ?? [])];
      expect(links.map(link => link.getAttribute('href'))).toEqual([
        'https://github.com/nwtgck/naidan',
        'https://github.com/nwtgck/naidan/blob/develop/LICENSE',
        'https://github.com/nwtgck/naidan',
        'https://github.com/nwtgck/naidan/commits',
        'https://github.com/nwtgck/naidan/blob/develop/.github/workflows/main.yml',
        'https://github.com/nwtgck/naidan/actions/workflows/main.yml',
        'https://github.com/nwtgck/naidan/blob/develop/README.md#development',
        'https://github.com/nwtgck/naidan/releases/latest',
      ]);
      for (const link of links) {
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.querySelectorAll('[data-docs-external-icon]')).toHaveLength(1);
      }
    }
  });
});
