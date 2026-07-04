import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

export const naidanAutoprefixerOptions = Object.freeze({});

const processor = postcss([
  autoprefixer(naidanAutoprefixerOptions),
]);

export function postprocessStaticTailwindCss({ css }) {
  return processor.process(css, { from: undefined }).css;
}

function parsedUrlValue({ node }) {
  if (node.nodes.length === 1 && node.nodes[0]?.type === 'string') {
    return node.nodes[0].value.trim();
  }
  return valueParser.stringify(node.nodes).trim();
}

function isRuntimeSafeUrl({ value }) {
  return value.startsWith('/')
    || value.startsWith('#')
    || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value);
}

function assertValueHasNoRelativeUrls({ value, context }) {
  valueParser(value).walk((node) => {
    if (node.type !== 'function' || node.value.toLowerCase() !== 'url') return;
    const urlValue = parsedUrlValue({ node });
    if (urlValue !== '' && isRuntimeSafeUrl({ value: urlValue })) return;
    throw new Error(
      '[tw-class] Split runtime CSS cannot preserve relative asset URLs. '
      + `Found ${JSON.stringify(urlValue)} in ${context}. `
      + 'Use an absolute URL, root-relative URL, fragment URL, or data URL.',
    );
  });
}

export function assertStaticTailwindCssHasNoRelativeUrls({ css }) {
  const root = postcss.parse(css);
  root.walkDecls((declaration) => {
    assertValueHasNoRelativeUrls({
      value: declaration.value,
      context: `declaration ${declaration.prop}`,
    });
  });
  root.walkAtRules((atRule) => {
    assertValueHasNoRelativeUrls({
      value: atRule.params,
      context: `@${atRule.name}`,
    });
  });
}
