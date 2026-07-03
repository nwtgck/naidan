import { NodeTypes, createSimpleExpression, parse as parseTemplate } from '@vue/compiler-dom';
import { processExpression } from '@vue/compiler-core';
import { parse as parseSfc } from '@vue/compiler-sfc';
import MagicString from 'magic-string';
import {
  parseTypeScriptExpression,
  createTypeScriptSourceFile,
  nodePosition,
  nodeRange,
  staticStringValue,
  ts,
  unwrapTypeScriptExpression,
  visitTypeScriptAst,
} from './typescript-ast-utils.mjs';
import { tailwindClassAttributeBySource } from './tailwind-class-attributes.mjs';

const virtualModuleId = 'virtual:naidan-tailwind';

function fail({ filename, message, loc }) {
  const location = loc === undefined ? '' : `:${loc.start.line}:${loc.start.column}`;
  throw new Error(`[tw-class] ${filename}${location} ${message}`);
}

function absolutePosition({ relative, blockStart, columnIsZeroBased }) {
  const relativeColumn = relative.column + (columnIsZeroBased ? 1 : 0);
  return {
    line: blockStart.line + relative.line - 1,
    column: relative.line === 1 ? blockStart.column + relativeColumn - 1 : relativeColumn,
  };
}

function createOccurrence({ candidate, filename, position, sourceKind }) {
  return { candidate, filename, line: position.line, column: position.column, sourceKind };
}

function parseOptionalTwClassTokens({ value }) {
  return value.trim().split(/\s+/u).filter(Boolean);
}

export function parseTwClassTokens({ value, filename, loc }) {
  const tokens = parseOptionalTwClassTokens({ value });
  if (tokens.length === 0) fail({ filename, loc, message: 'Tailwind class attribute must contain at least one class literal.' });
  return tokens;
}

function expressionLoc({ sourceFile, node }) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { start: { line: position.line + 1, column: position.character + 1 } };
}

function isIdentifierCall({ node, name }) {
  const expression = unwrapTypeScriptExpression({ node: node.expression });
  return ts.isIdentifier(expression) && expression.text === name;
}

function unwrapTopLevelClassWrapper({ expression, wrapperName, filename, loc }) {
  let parsed;
  try {
    parsed = parseTypeScriptExpression({ expression, filename: `${filename}.template-expression.ts` });
  } catch (error) {
    fail({ filename, loc, message: `Unable to parse class expression: ${String(error)}` });
  }
  const root = unwrapTypeScriptExpression({ node: parsed.root });
  if (!ts.isCallExpression(root) || !isIdentifierCall({ node: root, name: wrapperName })) return undefined;
  if (root.arguments.length !== 1) fail({ filename, loc, message: `${wrapperName}() requires exactly one class value argument.` });
  const range = nodeRange({ sourceFile: parsed.sourceFile, node: root.arguments[0], offset: parsed.offset });
  return expression.slice(range.start, range.end);
}

function objectKeyText({ property, sourceFile }) {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name)) return property.name.text;
  return property.name.getText(sourceFile);
}

export function parseTwClassExpression({ expression, filename, loc }) {
  let parsed;
  try {
    parsed = parseTypeScriptExpression({ expression, filename: `${filename}.template-expression.ts` });
  } catch (error) {
    fail({ filename, loc, message: `Unable to parse :tw-class expression: ${String(error)}` });
  }
  const classes = [];
  const dynamicWrappers = [];
  function visit(input) {
    const node = unwrapTypeScriptExpression({ node: input });
    if (ts.isCallExpression(node) && isIdentifierCall({ node, name: 'twClasses' })) {
      if (node.arguments.length !== 1) fail({ filename, loc, message: 'twClasses() requires exactly one class value argument.' });
      const nodeRangeValue = nodeRange({ sourceFile: parsed.sourceFile, node, offset: parsed.offset });
      const argumentRange = nodeRange({ sourceFile: parsed.sourceFile, node: node.arguments[0], offset: parsed.offset });
      dynamicWrappers.push({
        start: nodeRangeValue.start,
        end: nodeRangeValue.end,
        replacement: expression.slice(argumentRange.start, argumentRange.end),
      });
      return;
    }
    const stringValue = staticStringValue({ node });
    if (stringValue !== undefined) {
      classes.push(...parseOptionalTwClassTokens({ value: stringValue }));
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) fail({ filename, loc, message: ':tw-class does not support spread elements.' });
        visit(element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property) || ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
          fail({ filename, loc, message: ':tw-class does not support object spreads, methods, or accessors.' });
        }
        const key = objectKeyText({ property, sourceFile: parsed.sourceFile });
        if (key === undefined) fail({ filename, loc, message: ':tw-class object keys must be non-computed string literals or identifiers.' });
        classes.push(...parseOptionalTwClassTokens({ value: key }));
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      visit(node.whenTrue);
      visit(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      visit(node.right);
      return;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return;
    fail({
      filename,
      loc,
      message: `:tw-class must be statically enumerable or wrapped in twClasses(); unsupported expression ${node.getText(parsed.sourceFile)}.`,
    });
  }
  visit(parsed.root);
  if (classes.length === 0 && dynamicWrappers.length === 0) {
    fail({ filename, loc, message: ':tw-class must contain at least one class literal or twClasses() value.' });
  }
  const runtimeExpression = new MagicString(expression);
  for (const wrapper of dynamicWrappers.sort((left, right) => right.start - left.start)) {
    runtimeExpression.overwrite(wrapper.start, wrapper.end, wrapper.replacement);
  }
  return { classes, runtimeExpression: runtimeExpression.toString(), dynamic: dynamicWrappers.length > 0 };
}

export function parseStaticTwClassExpression({ expression, filename, loc }) {
  const result = parseTwClassExpression({ expression, filename, loc });
  if (result.dynamic) fail({ filename, loc, message: 'Expected a statically enumerable :tw-class expression, but received twClasses().' });
  return result.classes;
}

function isStaticArgument({ argument, name }) {
  return argument?.type === NodeTypes.SIMPLE_EXPRESSION && argument.isStatic && argument.content === name;
}

function classAttributeDefinition({ prop }) {
  if (prop.type === NodeTypes.ATTRIBUTE) return tailwindClassAttributeBySource.get(prop.name);
  if (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic) {
    return tailwindClassAttributeBySource.get(prop.arg.content);
  }
  return undefined;
}

export function collectTwCandidateOccurrencesFromTemplateAst({ ast, filename, blockStart }) {
  const occurrences = [];
  const visited = new Set();
  function visit(node) {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.type === NodeTypes.ELEMENT) {
      for (const prop of node.props) {
        const definition = classAttributeDefinition({ prop });
        if (definition === undefined) continue;
        const position = absolutePosition({ relative: prop.loc.start, blockStart, columnIsZeroBased: false });
        if (prop.type === NodeTypes.ATTRIBUTE) {
          if (prop.value === undefined) fail({ filename, loc: prop.loc, message: `${definition.source} requires a static string value.` });
          for (const token of parseTwClassTokens({ value: prop.value.content, filename, loc: prop.loc })) {
            occurrences.push(createOccurrence({ candidate: token, filename, position, sourceKind: definition.source }));
          }
          continue;
        }
        if (definition.target !== 'class') {
          fail({ filename, loc: prop.loc, message: `Dynamic :${definition.source} is not supported. Use a static ${definition.source} value.` });
        }
        if (prop.exp === undefined) fail({ filename, loc: prop.loc, message: ':tw-class requires an expression.' });
        const expression = typeof prop.exp.content === 'string' ? prop.exp.content : prop.exp.loc.source;
        for (const token of parseTwClassExpression({ expression, filename, loc: prop.loc }).classes) {
          occurrences.push(createOccurrence({ candidate: token, filename, position, sourceKind: ':tw-class' }));
        }
      }
    }
    if ('children' in node && Array.isArray(node.children)) node.children.forEach(visit);
    if (node.type === NodeTypes.IF) node.branches.forEach(visit);
  }
  visit(ast);
  return occurrences;
}

export function collectTwCandidateOccurrencesFromVueSource({ source, filename }) {
  const { descriptor, errors } = parseSfc(source, { filename });
  if (errors.length > 0) fail({ filename, message: `Unable to parse Vue SFC: ${errors.map(String).join('; ')}` });
  const occurrences = [];
  if (descriptor.template !== null) {
    const templateAst = parseTemplate(descriptor.template.content, {
      comments: true,
      expressionPlugins: ['typescript'],
      onError(error) { fail({ filename, loc: error.loc, message: error.message }); },
    });
    occurrences.push(...collectTwCandidateOccurrencesFromTemplateAst({ ast: templateAst, filename, blockStart: descriptor.template.loc.start }));
  }
  for (const scriptBlock of [descriptor.script, descriptor.scriptSetup]) {
    if (scriptBlock === null) continue;
    const result = transformTwCallsInModule({
      source: scriptBlock.content,
      filename,
      sourceType: scriptBlock.lang === 'js' || scriptBlock.lang === 'jsx' ? 'javascript' : 'typescript',
      blockStart: scriptBlock.loc.start,
      additionalImports: [],
    });
    occurrences.push(...result.occurrences);
  }
  return occurrences;
}

function staticPropsByName({ node, name }) {
  return node.props.filter((prop) => prop.type === NodeTypes.ATTRIBUTE && prop.name === name);
}

function dynamicPropsByName({ node, name }) {
  return node.props.filter((prop) => prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && isStaticArgument({ argument: prop.arg, name }));
}

export function createTwClassNodeTransform({ filename }) {
  return (node, context) => {
    if (node.type !== NodeTypes.ELEMENT) return;
    for (const prop of node.props) {
      const sourceName = prop.type === NodeTypes.ATTRIBUTE
        ? prop.name
        : prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && prop.arg?.type === NodeTypes.SIMPLE_EXPRESSION && prop.arg.isStatic
          ? prop.arg.content
          : undefined;
      if (sourceName?.startsWith('tw-') && !tailwindClassAttributeBySource.has(sourceName)) {
        fail({ filename, loc: prop.loc, message: `Unknown Tailwind class attribute ${sourceName}.` });
      }
    }

    for (const classProp of dynamicPropsByName({ node, name: 'class' })) {
      if (classProp.exp === undefined) continue;
      const expression = classProp.exp.loc.source;
      const unwrapped = unwrapTopLevelClassWrapper({ expression, wrapperName: 'customClasses', filename, loc: classProp.loc });
      if (unwrapped === undefined) continue;
      classProp.exp = processExpression(createSimpleExpression(unwrapped, false, classProp.exp.loc), context);
    }

    for (const definition of tailwindClassAttributeBySource.values()) {
      const staticTwProps = staticPropsByName({ node, name: definition.source });
      const dynamicTwProps = dynamicPropsByName({ node, name: definition.source });
      if (staticTwProps.length > 1) fail({ filename, loc: staticTwProps[1].loc, message: `Only one ${definition.source} attribute is allowed per element.` });
      if (dynamicTwProps.length > 1) fail({ filename, loc: dynamicTwProps[1].loc, message: `Only one :${definition.source} binding is allowed per element.` });
      if (staticTwProps.length === 1 && dynamicTwProps.length === 1) {
        fail({ filename, loc: dynamicTwProps[0].loc, message: `Do not combine ${definition.source} and :${definition.source} on one element because vue-tsc treats them as duplicate attributes.` });
      }
      if (staticTwProps.length === 1) {
        const twProp = staticTwProps[0];
        if (twProp.value === undefined) fail({ filename, loc: twProp.loc, message: `${definition.source} requires a static string value.` });
        parseTwClassTokens({ value: twProp.value.content, filename, loc: twProp.loc });
        const targetStaticProps = staticPropsByName({ node, name: definition.target }).filter((prop) => prop !== twProp);
        const targetDynamicProps = dynamicPropsByName({ node, name: definition.target });
        if (targetStaticProps.length > 1 || targetDynamicProps.length > 1) {
          fail({ filename, loc: twProp.loc, message: `Multiple ${definition.target} attributes cannot be merged safely.` });
        }
        if (definition.target !== 'class' && targetDynamicProps.length > 0) {
          fail({ filename, loc: twProp.loc, message: `${definition.source} cannot be combined with :${definition.target}.` });
        }
        const targetStatic = targetStaticProps[0];
        if (targetStatic?.type === NodeTypes.ATTRIBUTE) {
          if (targetStatic.value === undefined) targetStatic.value = twProp.value;
          else targetStatic.value.content = `${targetStatic.value.content} ${twProp.value.content}`;
          node.props.splice(node.props.indexOf(twProp), 1);
        } else twProp.name = definition.target;
      }
      if (dynamicTwProps.length === 1) {
        const twProp = dynamicTwProps[0];
        if (definition.target !== 'class') {
          fail({ filename, loc: twProp.loc, message: `Dynamic :${definition.source} is not supported. Use a static ${definition.source} value.` });
        }
        if (twProp.exp === undefined) fail({ filename, loc: twProp.loc, message: ':tw-class requires an expression.' });
        const parsed = parseTwClassExpression({ expression: twProp.exp.loc.source, filename, loc: twProp.loc });
        twProp.exp = processExpression(createSimpleExpression(parsed.runtimeExpression, false, twProp.exp.loc), context);
        const targetDynamic = dynamicPropsByName({ node, name: 'class' }).find((prop) => prop !== twProp);
        if (targetDynamic?.type === NodeTypes.DIRECTIVE) {
          if (targetDynamic.exp === undefined) fail({ filename, loc: targetDynamic.loc, message: ':class requires an expression.' });
          const original = targetDynamic.exp.loc.source;
          const custom = unwrapTopLevelClassWrapper({ expression: original, wrapperName: 'customClasses', filename, loc: targetDynamic.loc }) ?? original;
          targetDynamic.exp = processExpression(createSimpleExpression(`[${custom}, ${parsed.runtimeExpression}]`, false, targetDynamic.exp.loc), context);
          node.props.splice(node.props.indexOf(twProp), 1);
        } else twProp.arg.content = 'class';
      }
    }
  };
}

function importBindingName({ specifier }) {
  if (!ts.isImportSpecifier(specifier)) return undefined;
  return { imported: (specifier.propertyName ?? specifier.name).text, local: specifier.name.text, typeOnly: specifier.isTypeOnly };
}

function isImportIdentifier({ node }) {
  return ts.isImportSpecifier(node.parent) || ts.isImportClause(node.parent) || ts.isNamespaceImport(node.parent) || ts.isImportEqualsDeclaration(node.parent);
}

function transformTwCallsIntoMagicString({
  source,
  filename,
  sourceType,
  blockStart,
  additionalImports,
  magicString,
  sourceOffset,
}) {
  const parseFilename = sourceType === 'javascript' && filename.endsWith('.ts') ? `${filename}.js` : filename;
  let sourceFile;
  try {
    sourceFile = createTypeScriptSourceFile({ source, filename: parseFilename });
  } catch (error) {
    fail({ filename, message: `Unable to parse module: ${String(error)}` });
  }
  const classes = new Set();
  const occurrences = [];
  const macroImports = [];
  const twLocalNames = new Set();
  const twClassStringLocalNames = new Set();
  const templateOnlyLocalNames = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== virtualModuleId) continue;
    macroImports.push(statement);
    const clause = statement.importClause;
    if (clause === undefined || clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) {
      fail({ filename, loc: expressionLoc({ sourceFile, node: statement }), message: 'virtual:naidan-tailwind only supports named imports.' });
    }
    for (const specifier of clause.namedBindings.elements) {
      const binding = importBindingName({ specifier });
      const isTypeOnly = clause.isTypeOnly || binding.typeOnly;
      if (isTypeOnly) {
        if (binding.imported !== 'TailwindClass' && binding.imported !== 'TailwindClassValue') {
          fail({ filename, loc: expressionLoc({ sourceFile, node: specifier }), message: `Unsupported virtual:naidan-tailwind type ${binding.imported}.` });
        }
        continue;
      }
      if (binding.imported === 'tw') twLocalNames.add(binding.local);
      else if (binding.imported === 'twClassString') {
        if (binding.local !== binding.imported) fail({ filename, loc: expressionLoc({ sourceFile, node: specifier }), message: 'twClassString may not be aliased.' });
        twClassStringLocalNames.add(binding.local);
      } else if (binding.imported === 'twClasses' || binding.imported === 'customClasses') {
        if (binding.local !== binding.imported) fail({ filename, loc: expressionLoc({ sourceFile, node: specifier }), message: `${binding.imported} may not be aliased because Vue template analysis uses its canonical name.` });
        templateOnlyLocalNames.add(binding.local);
      } else fail({ filename, loc: expressionLoc({ sourceFile, node: specifier }), message: `Unsupported virtual:naidan-tailwind macro ${binding.imported}.` });
    }
  }
  if (macroImports.length === 0 && additionalImports.length === 0) {
    return { classes, occurrences, changed: false };
  }

  visitTypeScriptAst({
    node: sourceFile,
    visitor(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(unwrapTypeScriptExpression({ node: node.expression }))) {
        const callee = unwrapTypeScriptExpression({ node: node.expression });
        if (twLocalNames.has(callee.text)) {
          if (node.arguments.length !== 1) fail({ filename, loc: expressionLoc({ sourceFile, node }), message: "tw() requires exactly one string literal, for example tw('opacity-50')." });
          const className = staticStringValue({ node: node.arguments[0] });
          if (className === undefined) fail({ filename, loc: expressionLoc({ sourceFile, node }), message: "tw() requires exactly one string literal, for example tw('opacity-50')." });
          const tokens = parseTwClassTokens({ value: className, filename, loc: expressionLoc({ sourceFile, node }) });
          if (tokens.length !== 1) fail({ filename, loc: expressionLoc({ sourceFile, node }), message: 'tw() accepts exactly one Tailwind class token.' });
          classes.add(className);
          occurrences.push(createOccurrence({ candidate: className, filename, position: nodePosition({ sourceFile, node, blockStart }), sourceKind: 'tw()' }));
          const range = nodeRange({ sourceFile, node, offset: 0 });
          magicString.overwrite(sourceOffset + range.start, sourceOffset + range.end, JSON.stringify(className));
          return;
        }
        if (twClassStringLocalNames.has(callee.text)) {
          if (node.arguments.length === 0) fail({ filename, loc: expressionLoc({ sourceFile, node }), message: 'twClassString() requires one or more string literals.' });
          const classNames = node.arguments.map((argument) => staticStringValue({ node: argument }));
          if (classNames.some((className) => className === undefined)) {
            fail({ filename, loc: expressionLoc({ sourceFile, node }), message: 'twClassString() requires one or more string literals, each containing exactly one Tailwind class token.' });
          }
          for (const className of classNames) {
            const tokens = parseTwClassTokens({ value: className, filename, loc: expressionLoc({ sourceFile, node }) });
            if (tokens.length !== 1) fail({ filename, loc: expressionLoc({ sourceFile, node }), message: 'Each twClassString() argument must contain exactly one Tailwind class token.' });
            classes.add(className);
            occurrences.push(createOccurrence({ candidate: className, filename, position: nodePosition({ sourceFile, node, blockStart }), sourceKind: 'twClassString()' }));
          }
          const range = nodeRange({ sourceFile, node, offset: 0 });
          magicString.overwrite(sourceOffset + range.start, sourceOffset + range.end, JSON.stringify(classNames.join(' ')));
        }
      }
      if (!ts.isIdentifier(node) || isImportIdentifier({ node })) return;
      const parent = node.parent;
      const isDirectCall = ts.isCallExpression(parent) && parent.expression === node;
      if (twLocalNames.has(node.text) && !isDirectCall) fail({ filename, loc: expressionLoc({ sourceFile, node }), message: 'tw may only be used as a direct function call.' });
      if (twClassStringLocalNames.has(node.text) && !isDirectCall) fail({ filename, loc: expressionLoc({ sourceFile, node }), message: 'twClassString may only be used as a direct function call.' });
      if (templateOnlyLocalNames.has(node.text)) fail({ filename, loc: expressionLoc({ sourceFile, node }), message: `${node.text} may only be used directly in a Vue template class binding.` });
    },
  });

  for (const declaration of macroImports) {
    magicString.remove(sourceOffset + declaration.getStart(sourceFile), sourceOffset + declaration.getEnd());
  }
  if (additionalImports.length > 0) {
    const imports = additionalImports.map((id) => `import ${JSON.stringify(id)};`).join('\n');
    magicString.appendLeft(sourceOffset + source.length, `\n${imports}\n`);
  }
  return { classes, occurrences, changed: true };
}

export function transformTwCallsInModule({ source, filename, sourceType, blockStart, additionalImports }) {
  const magicString = new MagicString(source);
  const result = transformTwCallsIntoMagicString({
    source,
    filename,
    sourceType,
    blockStart,
    additionalImports,
    magicString,
    sourceOffset: 0,
  });
  return {
    code: result.changed ? magicString.toString() : source,
    map: result.changed ? magicString.generateMap({ hires: true, source: filename, includeContent: true }) : null,
    classes: result.classes,
    occurrences: result.occurrences,
    changed: result.changed,
  };
}

export function transformTwCallsInVueSource({ source, filename, additionalImports }) {
  const { descriptor, errors } = parseSfc(source, { filename });
  if (errors.length > 0) fail({ filename, message: `Unable to parse Vue SFC: ${errors.map(String).join('; ')}` });
  const magicString = new MagicString(source);
  const importBlock = descriptor.scriptSetup ?? descriptor.script;
  let changed = false;
  for (const scriptBlock of [descriptor.script, descriptor.scriptSetup]) {
    if (scriptBlock === null) continue;
    const result = transformTwCallsIntoMagicString({
      source: scriptBlock.content,
      filename,
      sourceType: scriptBlock.lang === 'js' || scriptBlock.lang === 'jsx' ? 'javascript' : 'typescript',
      blockStart: scriptBlock.loc.start,
      additionalImports: scriptBlock === importBlock ? additionalImports : [],
      magicString,
      sourceOffset: scriptBlock.loc.start.offset,
    });
    changed ||= result.changed;
  }
  if (importBlock === null && additionalImports.length > 0) {
    const imports = additionalImports.map((id) => `import ${JSON.stringify(id)};`).join('\n');
    magicString.prepend(`<script>\n${imports}\n</script>\n`);
    changed = true;
  }
  return {
    code: changed ? magicString.toString() : source,
    map: changed ? magicString.generateMap({ hires: true, source: filename, includeContent: true }) : null,
    changed,
  };
}
