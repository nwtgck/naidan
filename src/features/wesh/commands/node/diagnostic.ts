import type { NodeParserDiagnostic } from './parser';

interface SourceLine {
  readonly text: string,
  readonly lineStart: number,
  readonly lineNumber: number,
}

function sourceLineAtOffset({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): SourceLine {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  let start = boundedOffset;
  while (start > 0 && source.charCodeAt(start - 1) !== 0x0a) {
    start -= 1;
  }

  let end = boundedOffset;
  while (end < source.length && source.charCodeAt(end) !== 0x0a) {
    end += 1;
  }
  if (end > start && source.charCodeAt(end - 1) === 0x0d) {
    end -= 1;
  }

  let lineNumber = 1;
  for (let cursor = 0; cursor < start; cursor += 1) {
    if (source.charCodeAt(cursor) === 0x0a) {
      lineNumber += 1;
    }
  }

  return {
    text: source.slice(start, end),
    lineStart: start,
    lineNumber,
  };
}

function detailNumber({
  diagnostic,
  key,
}: {
  diagnostic: NodeParserDiagnostic,
  key: string,
}): number | undefined {
  const value = diagnostic.details[key];
  return typeof value === 'number' ? value : undefined;
}

function detailStringArray({
  diagnostic,
  key,
}: {
  diagnostic: NodeParserDiagnostic,
  key: string,
}): readonly string[] | undefined {
  const value = diagnostic.details[key];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function detailString({
  diagnostic,
  key,
}: {
  diagnostic: NodeParserDiagnostic,
  key: string,
}): string | undefined {
  const value = diagnostic.details[key];
  return typeof value === 'string' ? value : undefined;
}

const javascriptKeywords = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

function isIdentifierStartCharacter({ character }: { character: string }): boolean {
  return /^[$_\p{ID_Start}]$/u.test(character);
}

function isIdentifierContinueCharacter({ character }: { character: string }): boolean {
  return /^[$\u200C\u200D\p{ID_Continue}]$/u.test(character);
}

function identifierAt({ source, offset }: { source: string, offset: number }): string | undefined {
  const codePoint = source.codePointAt(offset);
  if (codePoint === undefined) {
    return undefined;
  }
  const first = String.fromCodePoint(codePoint);
  if (!isIdentifierStartCharacter({ character: first })) {
    return undefined;
  }

  let cursor = offset + first.length;
  while (cursor < source.length) {
    const nextCodePoint = source.codePointAt(cursor);
    if (nextCodePoint === undefined) break;
    const character = String.fromCodePoint(nextCodePoint);
    if (!isIdentifierContinueCharacter({ character })) {
      break;
    }
    cursor += character.length;
  }
  return source.slice(offset, cursor);
}

function privateIdentifierAt({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): string | undefined {
  if (source[offset] !== '#') {
    return undefined;
  }
  const identifier = identifierAt({ source, offset: offset + 1 });
  return identifier === undefined ? undefined : `#${identifier}`;
}

function nextNonWhitespaceOffset({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): number | undefined {
  let cursor = Math.max(0, Math.min(offset, source.length));
  while (cursor < source.length && /\s/u.test(source[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor < source.length ? cursor : undefined;
}

function identifierBeforeOffset({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): { readonly offset: number, readonly text: string } | undefined {
  let cursor = Math.min(offset, source.length) - 1;
  while (cursor >= 0 && /\s/u.test(source[cursor] ?? '')) {
    cursor -= 1;
  }
  const end = cursor + 1;
  while (cursor >= 0 && isIdentifierContinueCharacter({ character: source[cursor] ?? '' })) {
    cursor -= 1;
  }
  const start = cursor + 1;
  if (start >= end) return undefined;
  const text = source.slice(start, end);
  return isIdentifierStartCharacter({ character: text[0] ?? '' })
    ? { offset: start, text }
    : undefined;
}

function restStartBeforeOffset({ source, offset }: { source: string, offset: number }): number | undefined {
  const start = source.lastIndexOf('...', Math.max(0, offset));
  return start >= 0 ? start : undefined;
}

function regexLiteralStartBeforeOffset({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): number | undefined {
  let cursor = Math.min(source.length, offset) - 1;
  while (cursor >= 0 && /[A-Za-z]/u.test(source[cursor] ?? '')) {
    cursor -= 1;
  }
  if (source[cursor] !== '/') return undefined;

  const closingSlash = cursor;
  cursor -= 1;
  while (cursor >= 0) {
    if (source[cursor] !== '/') {
      cursor -= 1;
      continue;
    }

    let backslashes = 0;
    for (let probe = cursor - 1; probe >= 0 && source[probe] === '\\'; probe -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return cursor;
    cursor -= 1;
  }

  return closingSlash;
}

function restElementSpan({ source, offset }: { source: string, offset: number }): DisplayLocation {
  const restStart = restStartBeforeOffset({ source, offset });
  if (restStart === undefined) return { offset, span: 1 };
  const comma = source.indexOf(',', restStart + 3);
  if (comma < 0) return { offset: restStart, span: 1 };
  let end = comma;
  while (end > restStart && /\s/u.test(source[end - 1] ?? '')) {
    end -= 1;
  }
  return { offset: restStart, span: Math.max(1, end - restStart) };
}

function assignmentLeftSpan({ source, offset }: { source: string, offset: number }): number {
  const equals = source.indexOf('=', offset);
  if (equals < 0) return 1;
  let end = equals;
  while (end > offset && /\s/u.test(source[end - 1] ?? '')) {
    end -= 1;
  }
  return Math.max(1, end - offset);
}

function declarationMissingInitializerLocation({
  source,
  diagnostic,
}: {
  source: string,
  diagnostic: NodeParserDiagnostic,
}): DisplayLocation {
  const kind = detailString({ diagnostic, key: 'kind' });
  if (kind !== 'destructuring') {
    const identifier = identifierBeforeOffset({ source, offset: diagnostic.offset });
    return identifier === undefined
      ? { offset: diagnostic.offset, span: 1 }
      : { offset: identifier.offset, span: identifier.text.length };
  }

  const line = sourceLineAtOffset({ source, offset: diagnostic.offset });
  const localDiagnosticOffset = Math.max(0, diagnostic.offset - line.lineStart);
  let declarationKeywordEnd = -1;
  for (const keyword of ['const ', 'let ', 'var '] as const) {
    const candidate = line.text.lastIndexOf(keyword, localDiagnosticOffset);
    if (candidate >= 0) {
      declarationKeywordEnd = Math.max(declarationKeywordEnd, candidate + keyword.length);
    }
  }
  if (declarationKeywordEnd < 0) {
    return { offset: diagnostic.offset, span: 1 };
  }

  let patternStart = declarationKeywordEnd;
  while (patternStart < line.text.length && /\s/u.test(line.text[patternStart] ?? '')) {
    patternStart += 1;
  }
  const absoluteStart = line.lineStart + patternStart;
  return {
    offset: absoluteStart,
    span: Math.max(1, diagnostic.offset - absoluteStart),
  };
}

function previousNonWhitespaceOffset({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): number | undefined {
  let cursor = Math.min(offset, source.length) - 1;
  while (cursor >= 0 && /\s/u.test(source[cursor] ?? '')) {
    cursor -= 1;
  }
  return cursor >= 0 ? cursor : undefined;
}

function privateFieldReferenceLocation({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): DisplayLocation {
  const precedingIdentifier = identifierBeforeOffset({ source, offset });
  if (precedingIdentifier !== undefined) {
    return { offset: precedingIdentifier.offset, span: 1 };
  }
  const precedingToken = previousNonWhitespaceOffset({ source, offset });
  return { offset: precedingToken ?? offset, span: 1 };
}

function classRedeclarationLocation({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): DisplayLocation | undefined {
  const line = sourceLineAtOffset({ source, offset });
  const localOffset = Math.max(0, offset - line.lineStart);
  const prefix = line.text.slice(0, localOffset);
  const classStart = prefix.lastIndexOf('class ');
  if (classStart < 0 || prefix.slice(classStart + 'class '.length).trim().length > 0) {
    return undefined;
  }
  const closeBrace = line.text.indexOf('}', localOffset);
  if (closeBrace < 0) {
    return undefined;
  }
  return {
    offset: line.lineStart + classStart,
    span: Math.max(1, closeBrace + 1 - classStart),
  };
}

function restParameterHasDefault({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): boolean {
  if (source[offset] !== '=') return false;
  const restStart = source.lastIndexOf('...', offset);
  if (restStart < 0) return false;
  const openParen = source.lastIndexOf('(', offset);
  const openBracket = source.lastIndexOf('[', offset);
  const openBrace = source.lastIndexOf('{', offset);
  return openParen > openBracket && openParen > openBrace && restStart > openParen;
}

function invalidCodePointLocation({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): DisplayLocation | undefined {
  const start = source.lastIndexOf('\\u{', offset);
  if (start < 0) return undefined;
  const close = source.indexOf('}', start + 3);
  if (close < 0 || close >= offset) return undefined;
  return { offset: start, span: Math.max(1, close - start) };
}

function numericLiteralSpan({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): number {
  let cursor = offset;
  while (cursor < source.length && /[0-9A-Fa-f_xXoObB.]/u.test(source[cursor] ?? '')) {
    cursor += 1;
  }
  return Math.max(1, cursor - offset);
}

function strictDeleteLocation({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): DisplayLocation {
  let cursor = offset + 'delete'.length;
  while (cursor < source.length && /\s/u.test(source[cursor] ?? '')) {
    cursor += 1;
  }
  const identifier = identifierAt({ source, offset: cursor });
  return identifier === undefined
    ? { offset: diagnosticSafeOffset({ source, offset }), span: 1 }
    : { offset: cursor, span: identifier.length };
}

function diagnosticSafeOffset({ source, offset }: { source: string, offset: number }): number {
  return Math.max(0, Math.min(offset, source.length));
}

function unaryExponentiationLocation({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): DisplayLocation {
  const line = sourceLineAtOffset({ source, offset });
  let start = offset;
  const previous = source[offset - 1];
  if (previous !== undefined && '+-!~'.includes(previous)) {
    start -= 1;
  } else {
    const prefix = source.slice(line.lineStart, offset);
    for (const keyword of ['typeof', 'void', 'delete'] as const) {
      const marker = `${keyword} `;
      if (prefix.endsWith(marker)) {
        start = offset - marker.length;
        break;
      }
    }
  }
  const exponent = source.indexOf('**', offset);
  if (exponent < 0 || exponent >= line.lineStart + line.text.length) {
    return { offset: start, span: 1 };
  }
  return { offset: start, span: Math.max(1, exponent + 2 - start) };
}

const javascriptPunctuatorsLongestFirst = [
  '>>>=',
  '**=',
  '&&=',
  '||=',
  '??=',
  '===',
  '!==',
  '>>>',
  '<<=',
  '>>=',
  '=>',
  '...',
  '==',
  '!=',
  '<=',
  '>=',
  '++',
  '--',
  '<<',
  '>>',
  '**',
  '&&',
  '||',
  '??',
  '?.',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
] as const;

function punctuatorAt({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): string | undefined {
  for (const punctuator of javascriptPunctuatorsLongestFirst) {
    if (!source.startsWith(punctuator, offset)) {
      continue;
    }
    if (punctuator === '?.' && /^[0-9]$/u.test(source[offset + punctuator.length] ?? '')) {
      continue;
    }
    return punctuator;
  }
  return undefined;
}

function tokenDisplayLocation({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): DisplayLocation {
  const privateIdentifier = privateIdentifierAt({ source, offset });
  if (privateIdentifier !== undefined) {
    return { offset, span: privateIdentifier.length };
  }
  const identifier = identifierAt({ source, offset });
  if (identifier !== undefined) {
    return { offset, span: identifier.length };
  }
  const punctuator = punctuatorAt({ source, offset });
  return { offset, span: punctuator?.length ?? 1 };
}

function unexpectedTokenMessageAt({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): string {
  if (offset >= source.length) {
    return 'Unexpected end of input';
  }

  const privateIdentifier = privateIdentifierAt({ source, offset });
  if (privateIdentifier !== undefined) {
    return `Unexpected identifier '${privateIdentifier}'`;
  }

  const identifier = identifierAt({ source, offset });
  if (identifier !== undefined) {
    if (identifier === 'await') {
      return 'Unexpected reserved word';
    }
    return javascriptKeywords.has(identifier)
      ? `Unexpected token '${identifier}'`
      : `Unexpected identifier '${identifier}'`;
  }

  const codePoint = source.codePointAt(offset);
  if (codePoint === undefined) {
    return 'Unexpected end of input';
  }
  const token = String.fromCodePoint(codePoint);
  if (/^[0-9]$/u.test(token)) {
    return 'Unexpected number';
  }
  const punctuator = punctuatorAt({ source, offset });
  if (punctuator !== undefined) {
    return `Unexpected token '${punctuator}'`;
  }
  if (/^[{}()[\];,.?:+*%&|^!~=<>/-]$/u.test(token)) {
    return `Unexpected token '${token}'`;
  }
  return 'Invalid or unexpected token';
}

function unexpectedTokenMessage({
  source,
  diagnostic,
}: {
  source: string,
  diagnostic: NodeParserDiagnostic,
}): string {
  return unexpectedTokenMessageAt({ source, offset: diagnostic.offset });
}

function tokenAfterKeyword({
  source,
  offset,
  keyword,
}: {
  source: string,
  offset: number,
  keyword: string,
}): number | undefined {
  return nextNonWhitespaceOffset({ source, offset: offset + keyword.length });
}

function radixPrefixLocation({
  source,
  diagnostic,
}: {
  source: string,
  diagnostic: NodeParserDiagnostic,
}): DisplayLocation | undefined {
  const radix = detailNumber({ diagnostic, key: 'radix' });
  const expectedPrefix = radix === 16
    ? '0x'
    : radix === 8
      ? '0o'
      : radix === 2
        ? '0b'
        : undefined;
  if (expectedPrefix === undefined || diagnostic.offset < expectedPrefix.length) {
    return undefined;
  }
  const start = diagnostic.offset - expectedPrefix.length;
  return source.slice(start, diagnostic.offset).toLowerCase() === expectedPrefix
    ? { offset: start, span: expectedPrefix.length }
    : undefined;
}

function numericPrefixBeforeSeparator({
  source,
  offset,
}: {
  source: string,
  offset: number,
}): DisplayLocation | undefined {
  if (offset < 2 || source[offset] !== '_') {
    return undefined;
  }
  const prefix = source.slice(offset - 2, offset).toLowerCase();
  return prefix === '0x' || prefix === '0o' || prefix === '0b'
    ? { offset: offset - 2, span: 2 }
    : undefined;
}

function diagnosticMessage({
  source,
  diagnostic,
}: {
  source: string,
  diagnostic: NodeParserDiagnostic,
}): string {
  switch (diagnostic.reasonCode) {
  case 'UnexpectedToken':
    return restParameterHasDefault({ source, offset: diagnostic.offset })
      ? 'Rest parameter may not have a default initializer'
      : unexpectedTokenMessage({ source, diagnostic });
  case 'MissingSemicolon': {
    const tokenOffset = nextNonWhitespaceOffset({ source, offset: diagnostic.offset });
    return tokenOffset === undefined
      ? 'Unexpected end of input'
      : unexpectedTokenMessageAt({ source, offset: tokenOffset });
  }
  case 'MissingClassName':
    return unexpectedTokenMessageAt({ source, offset: diagnostic.offset });
  case 'VarRedeclaration': {
    const identifier = detailString({ diagnostic, key: 'identifierName' });
    return identifier === undefined
      ? 'Identifier has already been declared'
      : `Identifier '${identifier}' has already been declared`;
  }
  case 'IllegalReturn':
    return 'Illegal return statement';
  case 'NoCatchOrFinally':
    return 'Missing catch or finally after try';
  case 'StrictWith':
    return 'Strict mode code may not include a with statement';
  case 'AwaitNotInAsyncContext':
    return 'await is only valid in async functions and the top level bodies of modules';
  case 'YieldNotInGeneratorFunction': {
    const tokenOffset = tokenAfterKeyword({ source, offset: diagnostic.offset, keyword: 'yield' });
    return tokenOffset === undefined
      ? 'Invalid or unexpected token'
      : unexpectedTokenMessageAt({ source, offset: tokenOffset });
  }
  case 'UnexpectedReservedWord':
    return 'Unexpected reserved word';
  case 'ImportOutsideModule': {
    const token = identifierAt({ source, offset: diagnostic.offset });
    return token === 'export'
      ? "Unexpected token 'export'"
      : 'Cannot use import statement outside a module';
  }
  case 'ImportMetaOutsideModule':
    return "Cannot use 'import.meta' outside a module";
  case 'DeclarationMissingInitializer': {
    const kind = detailString({ diagnostic, key: 'kind' });
    return kind === undefined
      ? 'Missing initializer in declaration'
      : `Missing initializer in ${kind} declaration`;
  }
  case 'DuplicateConstructor':
    return 'A class may only have one constructor';
  case 'PrivateNameRedeclaration': {
    const identifier = detailString({ diagnostic, key: 'identifierName' });
    return identifier === undefined
      ? 'Private identifier has already been declared'
      : `Identifier '#${identifier}' has already been declared`;
  }
  case 'IllegalBreakContinue': {
    const type = detailString({ diagnostic, key: 'type' });
    return type === 'ContinueStatement'
      ? 'Illegal continue statement: no surrounding iteration statement'
      : 'Illegal break statement';
  }
  case 'InvalidLhs': {
    const operation = detailString({ diagnostic, key: 'operation' });
    switch (operation) {
    case 'prefix-update':
      return 'Invalid left-hand side expression in prefix operation';
    case 'postfix-update':
      return 'Invalid left-hand side expression in postfix operation';
    case 'assignment':
    case undefined:
      return 'Invalid left-hand side in assignment';
    default:
      return 'Invalid left-hand side in assignment';
    }
  }
  case 'UnexpectedKeyword': {
    const keyword = detailString({ diagnostic, key: 'keyword' });
    return keyword === undefined
      ? 'Invalid or unexpected token'
      : `Unexpected token '${keyword}'`;
  }
  case 'MissingPlugin': {
    const plugins = detailStringArray({ diagnostic, key: 'missingPlugin' });
    if (plugins?.includes('optionalChainingAssign') === true) {
      return 'Invalid left-hand side in assignment';
    }
    return plugins?.includes('partialApplication') === true
      ? "Unexpected token '?'"
      : 'Invalid or unexpected token';
  }
  case 'UnexpectedPrivateField': {
    const identifier = privateIdentifierAt({ source, offset: diagnostic.offset });
    return identifier === undefined
      ? 'Invalid or unexpected token'
      : `Unexpected identifier '${identifier}'`;
  }
  case 'DuplicateProto':
    return 'Duplicate __proto__ fields are not allowed in object literals';
  case 'LabelRedeclaration': {
    const label = detailString({ diagnostic, key: 'labelName' });
    return label === undefined
      ? 'Label has already been declared'
      : `Label '${label}' has already been declared`;
  }
  case 'StrictEvalArgumentsBinding':
    return 'Unexpected eval or arguments in strict mode';
  case 'SuperNotAllowed':
  case 'UnexpectedSuper':
  case 'UnsupportedSuper':
    return "'super' keyword unexpected here";
  case 'MalformedRegExpFlags':
  case 'DuplicateRegExpFlags':
  case 'IncompatibleRegExpUVFlags':
    return 'Invalid regular expression flags';
  case 'RestTrailingComma':
    return 'Rest element must be last element';
  case 'InvalidPrivateFieldResolution':
  case 'PrivateInExpectedIn': {
    const identifier = detailString({ diagnostic, key: 'identifierName' });
    return identifier === undefined
      ? 'Private field must be declared in an enclosing class'
      : `Private field '#${identifier}' must be declared in an enclosing class`;
  }
  case 'ConstructorIsAsync':
    return 'Class constructor may not be an async method';
  case 'ConstructorIsGenerator':
    return 'Class constructor may not be a generator';
  case 'NewlineAfterThrow':
    return 'Illegal newline after throw';
  case 'MixingCoalesceWithLogical': {
    const token = source.slice(diagnostic.offset, diagnostic.offset + 2);
    return token === '||' || token === '&&'
      ? `Unexpected token '${token}'`
      : 'Invalid or unexpected token';
  }
  case 'UnexpectedTokenUnaryExponentiation':
    return 'Unary operator used immediately before exponentiation expression. Parenthesis must be used to disambiguate operator precedence';
  case 'InvalidCodePoint':
    return 'Undefined Unicode code-point';
  case 'UnexpectedNumericSeparator':
    if (numericPrefixBeforeSeparator({ source, offset: diagnostic.offset }) !== undefined) {
      return 'Invalid or unexpected token';
    }
    return source[diagnostic.offset + 1] === '_'
      ? 'Only one underscore is allowed as numeric separator'
      : 'Numeric separators are not allowed at the end of numeric literals';
  case 'InvalidDigit':
    return 'Invalid or unexpected token';
  case 'InvalidBigIntLiteral':
    return 'Invalid or unexpected token';
  case 'StrictOctalLiteral':
    return 'Octal literals are not allowed in strict mode.';
  case 'StrictDelete':
    return 'Delete of an unqualified identifier in strict mode.';
  case 'ElementAfterRest': {
    const restStart = restStartBeforeOffset({ source, offset: diagnostic.offset });
    const openParen = restStart === undefined ? -1 : source.lastIndexOf('(', restStart);
    const openBracket = restStart === undefined ? -1 : source.lastIndexOf('[', restStart);
    const openBrace = restStart === undefined ? -1 : source.lastIndexOf('{', restStart);
    return openParen > openBracket && openParen > openBrace
      ? 'Rest parameter must be last formal parameter'
      : 'Rest element must be last element';
  }
  case 'ParamDupe':
    return 'Duplicate parameter name not allowed in this context';
  case 'UnterminatedString':
    return 'Invalid or unexpected token';
  case 'UnterminatedRegExp':
    return 'Invalid regular expression: missing /';
  case 'UnterminatedTemplate':
    return 'Unexpected end of input';
  case 'UnsupportedUsingDeclaration': {
    const identifier = identifierAt({ source, offset: diagnostic.offset });
    return identifier === undefined
      ? 'Unexpected identifier'
      : `Unexpected identifier '${identifier}'`;
  }
  case 'InvalidRegExpLiteral':
    return detailString({ diagnostic, key: 'message' }) ?? 'Invalid regular expression';
  default:
    return 'Invalid or unexpected token';
  }
}

interface DisplayLocation {
  readonly offset: number,
  readonly span: number,
}

function displayLocation({
  source,
  diagnostic,
}: {
  source: string,
  diagnostic: NodeParserDiagnostic,
}): DisplayLocation {
  switch (diagnostic.reasonCode) {
  case 'VarRedeclaration':
    return classRedeclarationLocation({ source, offset: diagnostic.offset })
      ?? { offset: diagnostic.offset, span: 1 };
  case 'MissingSemicolon': {
    const tokenOffset = nextNonWhitespaceOffset({ source, offset: diagnostic.offset });
    return tokenOffset === undefined
      ? { offset: diagnostic.offset, span: 0 }
      : tokenDisplayLocation({ source, offset: tokenOffset });
  }
  case 'MissingClassName':
    return tokenDisplayLocation({ source, offset: diagnostic.offset });
  case 'IllegalReturn':
    return { offset: diagnostic.offset, span: 6 };
  case 'StrictWith':
    return { offset: diagnostic.offset, span: 4 };
  case 'AwaitNotInAsyncContext':
    return { offset: diagnostic.offset, span: 5 };
  case 'YieldNotInGeneratorFunction': {
    const tokenOffset = tokenAfterKeyword({ source, offset: diagnostic.offset, keyword: 'yield' });
    return tokenOffset === undefined
      ? { offset: diagnostic.offset, span: 1 }
      : tokenDisplayLocation({ source, offset: tokenOffset });
  }
  case 'UnexpectedReservedWord': {
    const word = detailString({ diagnostic, key: 'reservedWord' });
    return { offset: diagnostic.offset, span: word?.length ?? 1 };
  }
  case 'ImportOutsideModule':
    return { offset: diagnostic.offset, span: 6 };
  case 'ImportMetaOutsideModule': {
    const metaOffset = source.startsWith('import.meta', diagnostic.offset)
      ? diagnostic.offset + 'import.'.length
      : diagnostic.offset;
    return { offset: metaOffset, span: source.startsWith('meta', metaOffset) ? 4 : 1 };
  }
  case 'DeclarationMissingInitializer':
    return declarationMissingInitializerLocation({ source, diagnostic });
  case 'DuplicateConstructor':
    return { offset: diagnostic.offset, span: 'constructor'.length };
  case 'PrivateNameRedeclaration': {
    const identifier = detailString({ diagnostic, key: 'identifierName' });
    const afterPrivateName = diagnostic.offset + 1 + (identifier?.length ?? 0);
    return { offset: Math.min(source.length, afterPrivateName), span: 1 };
  }
  case 'IllegalBreakContinue': {
    const type = detailString({ diagnostic, key: 'type' });
    return {
      offset: diagnostic.offset,
      span: type === 'ContinueStatement' ? 'continue'.length : 'break'.length,
    };
  }
  case 'InvalidLhs': {
    const operation = detailString({ diagnostic, key: 'operation' });
    const targetStart = detailNumber({ diagnostic, key: 'targetStart' });
    const targetEnd = detailNumber({ diagnostic, key: 'targetEnd' });
    if (targetStart !== undefined && targetEnd !== undefined && targetEnd > targetStart) {
      return { offset: targetStart, span: targetEnd - targetStart };
    }
    return operation === 'assignment'
      ? { offset: diagnostic.offset, span: assignmentLeftSpan({ source, offset: diagnostic.offset }) }
      : { offset: diagnostic.offset, span: 1 };
  }
  case 'InvalidPrivateFieldResolution':
    return source[diagnostic.offset] === '#' && diagnostic.offset > 0
      ? { offset: diagnostic.offset - 1, span: 1 }
      : { offset: diagnostic.offset, span: 1 };
  case 'PrivateInExpectedIn':
    return privateFieldReferenceLocation({ source, offset: diagnostic.offset });
  case 'ConstructorIsAsync':
  case 'ConstructorIsGenerator':
    return { offset: diagnostic.offset, span: 'constructor'.length };
  case 'NewlineAfterThrow': {
    const keyword = identifierBeforeOffset({ source, offset: diagnostic.offset });
    return keyword?.text === 'throw'
      ? { offset: keyword.offset, span: keyword.text.length }
      : { offset: diagnostic.offset, span: 1 };
  }
  case 'MixingCoalesceWithLogical':
    return { offset: diagnostic.offset, span: 2 };
  case 'UnexpectedTokenUnaryExponentiation':
    return unaryExponentiationLocation({ source, offset: diagnostic.offset });
  case 'InvalidCodePoint':
    return invalidCodePointLocation({ source, offset: diagnostic.offset })
      ?? { offset: diagnostic.offset, span: 1 };
  case 'NumberIdentifier':
    return { offset: Math.max(0, diagnostic.offset - 1), span: 1 };
  case 'UnexpectedNumericSeparator': {
    const prefix = numericPrefixBeforeSeparator({ source, offset: diagnostic.offset });
    return prefix ?? {
      offset: Math.min(source.length, diagnostic.offset + 1),
      span: 1,
    };
  }
  case 'InvalidDigit':
    return radixPrefixLocation({ source, diagnostic })
      ?? { offset: diagnostic.offset, span: 1 };
  case 'InvalidBigIntLiteral':
    return { offset: diagnostic.offset, span: numericLiteralSpan({ source, offset: diagnostic.offset }) };
  case 'StrictOctalLiteral':
    return { offset: diagnostic.offset, span: numericLiteralSpan({ source, offset: diagnostic.offset }) };
  case 'StrictDelete':
    return strictDeleteLocation({ source, offset: diagnostic.offset });
  case 'UnexpectedKeyword': {
    const keyword = detailString({ diagnostic, key: 'keyword' });
    return { offset: diagnostic.offset, span: keyword?.length ?? 1 };
  }
  case 'MissingPlugin': {
    const plugins = detailStringArray({ diagnostic, key: 'missingPlugin' });
    return plugins?.includes('optionalChainingAssign') === true
      ? { offset: diagnostic.offset, span: assignmentLeftSpan({ source, offset: diagnostic.offset }) }
      : { offset: diagnostic.offset, span: 1 };
  }
  case 'UnexpectedPrivateField':
    return tokenDisplayLocation({ source, offset: diagnostic.offset });
  case 'DuplicateProto':
    return { offset: diagnostic.offset, span: '__proto__'.length };
  case 'LabelRedeclaration':
    return { offset: diagnostic.offset, span: 1 };
  case 'StrictEvalArgumentsBinding': {
    const binding = detailString({ diagnostic, key: 'bindingName' });
    return { offset: diagnostic.offset, span: binding?.length ?? 1 };
  }
  case 'SuperNotAllowed':
  case 'UnexpectedSuper':
  case 'UnsupportedSuper':
    return { offset: diagnostic.offset, span: 'super'.length };
  case 'MalformedRegExpFlags':
  case 'DuplicateRegExpFlags': {
    const start = regexLiteralStartBeforeOffset({ source, offset: diagnostic.offset });
    return { offset: start ?? diagnostic.offset, span: 1 };
  }
  case 'IncompatibleRegExpUVFlags': {
    const start = regexLiteralStartBeforeOffset({ source, offset: diagnostic.offset });
    return start === undefined
      ? { offset: diagnostic.offset, span: 1 }
      : { offset: start, span: Math.max(1, diagnostic.offset - start) };
  }
  case 'RestTrailingComma':
    return restElementSpan({ source, offset: diagnostic.offset });
  case 'ElementAfterRest': {
    const restStart = restStartBeforeOffset({ source, offset: diagnostic.offset });
    const openParen = restStart === undefined ? -1 : source.lastIndexOf('(', restStart);
    const openBracket = restStart === undefined ? -1 : source.lastIndexOf('[', restStart);
    const openBrace = restStart === undefined ? -1 : source.lastIndexOf('{', restStart);
    if (openParen > openBracket && openParen > openBrace) {
      return { offset: diagnostic.offset, span: 1 };
    }
    if (source[diagnostic.offset] === ',') {
      const previous = previousNonWhitespaceOffset({ source, offset: diagnostic.offset });
      if (previous !== undefined) {
        return { offset: previous, span: 1 };
      }
    }
    return { offset: diagnostic.offset, span: 1 };
  }
  case 'ParamDupe':
    return { offset: diagnostic.offset, span: 1 };
  case 'UnterminatedString': {
    const line = sourceLineAtOffset({ source, offset: diagnostic.offset });
    return {
      offset: diagnostic.offset,
      span: Math.max(1, line.text.length - (diagnostic.offset - line.lineStart)),
    };
  }
  case 'UnterminatedRegExp':
    return { offset: Math.max(0, diagnostic.offset - 1), span: 1 };
  case 'UnterminatedTemplate':
    return { offset: source.length, span: 0 };
  case 'UnsupportedUsingDeclaration':
    return { offset: diagnostic.offset, span: 1 };
  case 'InvalidRegExpLiteral':
    return { offset: diagnostic.offset, span: detailNumber({ diagnostic, key: 'span' }) ?? 1 };
  case 'UnexpectedToken':
    return diagnostic.offset >= source.length
      ? { offset: diagnostic.offset, span: 0 }
      : tokenDisplayLocation({ source, offset: diagnostic.offset });
  default:
    return { offset: diagnostic.offset, span: 1 };
  }
}

function caretPrefix({ line, offset }: { line: SourceLine, offset: number }): string {
  const before = line.text.slice(0, Math.max(0, offset - line.lineStart));
  let result = '';
  for (const character of before) {
    result += character === '\t' ? '\t' : ' ';
  }
  return result;
}

export function renderNodeSyntaxDiagnostic({
  source,
  displayName,
  diagnostic,
}: {
  source: string,
  displayName: string,
  diagnostic: NodeParserDiagnostic,
}): string {
  const location = displayLocation({ source, diagnostic });
  const line = sourceLineAtOffset({ source, offset: location.offset });
  const prefix = caretPrefix({ line, offset: location.offset });
  const caret = location.span > 0 ? '^'.repeat(location.span) : '';
  const message = diagnosticMessage({ source, diagnostic });

  return `${displayName}:${line.lineNumber}\n${line.text}\n${prefix}${caret}\n\nSyntaxError: ${message}\n`;
}

export const TEST_ONLY = {
  sourceLineAtOffset,
  identifierAt,
  diagnosticMessage,
  displayLocation,
  caretPrefix,
};
