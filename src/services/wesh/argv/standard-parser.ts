import { ArgvScanner } from './scanner';
import type {
  ArgvDiagnostic,
  ArgvOptionEffect,
  ArgvOptionSpec,
  ParsedStandardArgv,
  StandardArgvParserSpec,
} from './types';

function applyEffects({
  optionValues,
  effects,
}: {
  optionValues: Record<string, boolean | string | number>;
  effects: ArgvOptionEffect[];
}): void {
  for (const effect of effects) {
    optionValues[effect.key] = effect.value;
  }
}

function createMissingValueDiagnostic({
  option,
  valueName,
}: {
  option: string;
  valueName: string;
}): ArgvDiagnostic {
  return {
    kind: 'missing-option-value',
    option,
    message: `${option} requires a value for ${valueName}`,
  };
}

function parseValueOption({
  option,
  rawValue,
}: {
  option: Extract<ArgvOptionSpec, { kind: 'value' }>;
  rawValue: string;
}): { ok: true; value: boolean | string | number } | { ok: false; diagnostic: ArgvDiagnostic } {
  if (option.parseValue === undefined) {
    return { ok: true, value: rawValue };
  }

  const parsed = option.parseValue({ value: rawValue });
  if (parsed.ok) {
    return { ok: true, value: parsed.value };
  }

  return {
    ok: false,
    diagnostic: {
      kind: 'invalid-option-value',
      option: option.long !== undefined ? `--${option.long}` : `-${option.short}`,
      message: parsed.message,
    },
  };
}

export function parseStandardArgv({
  args,
  spec,
}: {
  args: string[];
  spec: StandardArgvParserSpec;
}): ParsedStandardArgv {
  const optionValues: Record<string, boolean | string | number> = {};
  const positionals: string[] = [];
  const diagnostics: ArgvDiagnostic[] = [];
  const shortOptions = new Map<string, ArgvOptionSpec>();
  const longOptions = new Map<string, ArgvOptionSpec>();

  for (const option of spec.options) {
    if (option.short !== undefined) shortOptions.set(option.short, option);
    if (option.long !== undefined) longOptions.set(option.long, option);
  }

  const scanner = new ArgvScanner({ tokens: args });
  const stopParsingOptions = false;

  while (scanner.hasMore()) {
    const token = scanner.peek();
    if (token === undefined) break;

    if (!stopParsingOptions && spec.stopAtDoubleDash && token === '--') {
      scanner.next();
      positionals.push(...scanner.consumeRest());
      break;
    }

    if (!stopParsingOptions) {
      let handledSpecial = false;
      for (const specialParser of spec.specialTokenParsers) {
        const result = specialParser({
          token,
          nextToken: scanner.peekNext(),
        });
        if (result === undefined) continue;

        applyEffects({ optionValues, effects: result.effects });
        scanner.consumeMany({ count: result.consumeCount });
        handledSpecial = true;
        break;
      }
      if (handledSpecial) continue;
    }

    if (
      !stopParsingOptions
      && token.startsWith('--')
      && token.length > 2
    ) {
      scanner.next();
      const optionBody = token.slice(2);
      const equalsIndex = optionBody.indexOf('=');
      const key = equalsIndex >= 0 ? optionBody.slice(0, equalsIndex) : optionBody;
      const inlineValue = equalsIndex >= 0 ? optionBody.slice(equalsIndex + 1) : undefined;
      const option = longOptions.get(key);

      if (option === undefined) {
        diagnostics.push({
          kind: 'unknown-long-option',
          option: `--${key}`,
          message: `unrecognized option '--${key}'`,
        });
        continue;
      }

      switch (option.kind) {
      case 'flag':
        applyEffects({ optionValues, effects: option.effects });
        continue;
      case 'value': {
        const value = inlineValue ?? scanner.next();
        if (value === undefined) {
          diagnostics.push(createMissingValueDiagnostic({
            option: `--${key}`,
            valueName: option.valueName,
          }));
          continue;
        }

        const parsedValue = parseValueOption({ option, rawValue: value });
        if (!parsedValue.ok) {
          diagnostics.push(parsedValue.diagnostic);
          continue;
        }

        optionValues[option.key] = parsedValue.value;
        continue;
      }
      default: {
        const _ex: never = option;
        throw new Error(`Unhandled option kind: ${_ex}`);
      }
      }

      continue;
    }

    if (
      !stopParsingOptions
      && token.startsWith('-')
      && token.length > 1
      && !(spec.treatSingleDashAsPositional && token === '-')
    ) {
      scanner.next();
      const shortBody = token.slice(1);

      shortOptionLoop:
      for (let index = 0; index < shortBody.length; index++) {
        const short = shortBody[index];
        if (short === undefined) continue;

        const option = shortOptions.get(short);
        if (option === undefined) {
          diagnostics.push({
            kind: 'unknown-short-option',
            option: `-${short}`,
            message: `invalid option -- '${short}'`,
          });
          break;
        }

        switch (option.kind) {
        case 'flag':
          applyEffects({ optionValues, effects: option.effects });
          if (!spec.allowShortFlagBundles && index < shortBody.length - 1) {
            positionals.push(`-${shortBody.slice(index + 1)}`);
            break shortOptionLoop;
          }
          continue;
        case 'value': {
          const attachedValue = shortBody.slice(index + 1);
          let value = attachedValue.length > 0 && option.allowAttachedValue ? attachedValue : undefined;
          if (value === undefined) {
            value = scanner.next();
          }

          if (value === undefined) {
            diagnostics.push(createMissingValueDiagnostic({
              option: `-${short}`,
              valueName: option.valueName,
            }));
            break shortOptionLoop;
          }

          const parsedValue = parseValueOption({ option, rawValue: value });
          if (!parsedValue.ok) {
            diagnostics.push(parsedValue.diagnostic);
            break shortOptionLoop;
          }

          optionValues[option.key] = parsedValue.value;
          break shortOptionLoop;
        }
        default: {
          const _ex: never = option;
          throw new Error(`Unhandled option kind: ${_ex}`);
        }
        }
      }
      continue;
    }

    positionals.push(token);
    scanner.next();
  }

  return { optionValues, positionals, diagnostics };
}
