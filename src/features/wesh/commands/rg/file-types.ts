import { compileRgGlobRule, type RgGlobRule } from './glob';

interface RgFileTypeDefinition {
  readonly name: string,
  readonly patterns: readonly string[],
}

const RG_FILE_TYPES: readonly RgFileTypeDefinition[] = [
  { name: 'c', patterns: ['*.[chH]', '*.[chH].in', '*.cats'] },
  { name: 'cpp', patterns: ['*.[ChH]', '*.[ChH].in', '*.[ch]pp', '*.[ch]pp.in', '*.[ch]xx', '*.[ch]xx.in', '*.cc', '*.cc.in', '*.hh', '*.hh.in', '*.inl'] },
  { name: 'css', patterns: ['*.css', '*.scss'] },
  { name: 'docker', patterns: ['*Dockerfile*'] },
  { name: 'go', patterns: ['*.go'] },
  { name: 'html', patterns: ['*.ejs', '*.htm', '*.html'] },
  { name: 'java', patterns: ['*.java', '*.jsp', '*.jspx', '*.properties'] },
  { name: 'js', patterns: ['*.cjs', '*.js', '*.jsx', '*.mjs', '*.vue'] },
  { name: 'json', patterns: ['*.json', '*.sarif', 'composer.lock'] },
  { name: 'kotlin', patterns: ['*.kt', '*.kts'] },
  { name: 'make', patterns: ['*.mak', '*.mk', '[Gg][Nn][Uu]makefile', '[Gg][Nn][Uu]makefile.am', '[Gg][Nn][Uu]makefile.in', '[Mm]akefile', '[Mm]akefile.am', '[Mm]akefile.in'] },
  { name: 'markdown', patterns: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'] },
  { name: 'md', patterns: ['*.markdown', '*.md', '*.mdown', '*.mdwn', '*.mdx', '*.mkd', '*.mkdn'] },
  { name: 'php', patterns: ['*.php', '*.php3', '*.php4', '*.php5', '*.php7', '*.php8', '*.pht', '*.phtml'] },
  { name: 'py', patterns: ['*.py', '*.pyi'] },
  { name: 'python', patterns: ['*.py', '*.pyi'] },
  { name: 'ruby', patterns: ['*.gemspec', '*.rb', '*.rbw', '.irbrc', 'Gemfile', 'Rakefile', 'config.ru'] },
  { name: 'rust', patterns: ['*.rs'] },
  { name: 'sh', patterns: ['*.bash', '*.bashrc', '*.csh', '*.cshrc', '*.ksh', '*.kshrc', '*.sh', '*.tcsh', '*.zsh', '.bash_login', '.bash_logout', '.bash_profile', '.bashrc', '.cshrc', '.kshrc', '.login', '.logout', '.profile', '.tcshrc', '.zlogin', '.zlogout', '.zprofile', '.zshenv', '.zshrc', 'bash_login', 'bash_logout', 'bash_profile', 'bashrc', 'profile', 'zlogin', 'zlogout', 'zprofile', 'zshenv', 'zshrc'] },
  { name: 'sql', patterns: ['*.psql', '*.sql'] },
  { name: 'swift', patterns: ['*.swift'] },
  { name: 'toml', patterns: ['*.toml', 'Cargo.lock'] },
  { name: 'ts', patterns: ['*.cts', '*.mts', '*.ts', '*.tsx'] },
  { name: 'vue', patterns: ['*.vue'] },
  { name: 'xml', patterns: ['*.dtd', '*.rng', '*.sch', '*.xhtml', '*.xjb', '*.xml', '*.xml.dist', '*.xsd', '*.xsl', '*.xslt'] },
  { name: 'yaml', patterns: ['*.yaml', '*.yml'] },
];

const RG_FILE_TYPE_MAP = new Map(RG_FILE_TYPES.map((definition) => [definition.name, definition]));

export function compileRgTypeRules({ filters }: {
  filters: readonly { readonly name: string, readonly exclude: boolean }[],
}): readonly RgGlobRule[] {
  const rules: RgGlobRule[] = [];
  for (const filter of filters) {
    const definition = RG_FILE_TYPE_MAP.get(filter.name);
    if (definition === undefined) throw new Error(`unrecognized file type: ${filter.name}`);
    for (const pattern of definition.patterns) {
      rules.push(compileRgGlobRule({
        rawPattern: filter.exclude ? `!${pattern}` : pattern,
        caseInsensitive: false,
      }));
    }
  }
  return rules;
}

export function getRgTypeListText(): string {
  return RG_FILE_TYPES
    .map((definition) => `${definition.name}: ${definition.patterns.join(', ')}`)
    .join('\n') + '\n';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
