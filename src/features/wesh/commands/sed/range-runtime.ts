import { exceedsSafeRegularExpressionInputLimit } from '@/features/wesh/commands/_shared/backtracking-safety';
import { addSedUnsigned64 } from './numeric-semantics';
import {
  isZeroSedAddress,
  type SedAddress,
  type SedCommandSelection,
} from './command-model';

export interface SedRangeRuntimeState {
  inRange: boolean;
  rangeStarted: boolean;
  rangeStartLine?: number;
  rangeEndedOnLine?: bigint;
}

interface SedRangeRuntimeCommand extends SedRangeRuntimeState {
  command: SedCommandSelection;
}

function matchesAddress({
  address,
  lineNumber,
  line,
  isLastLine,
}: {
  address: SedAddress | undefined;
  lineNumber: number;
  line: string;
  isLastLine: boolean;
}): boolean {
  if (address === undefined) return true;

  switch (address.kind) {
  case "line":
    return BigInt(lineNumber) === address.lineNumber;
  case "last":
    return isLastLine;
  case "zero":
    return false;
  case "regex":
    if (exceedsSafeRegularExpressionInputLimit({ regex: address.regex, input: line })) {
      throw new Error('sed: regular expression input exceeds the safe backtracking limit');
    }
    address.regex.lastIndex = 0;
    return address.regex.test(line);
  case "lineStep": {
    const currentLine = BigInt(lineNumber);
    if (address.step === 0n) return currentLine === address.first;
    if (address.first === 0n) return currentLine % address.step === 0n;
    return currentLine >= address.first && (currentLine - address.first) % address.step === 0n;
  }
  case "relativeOffset":
  case "relativeModulo":
    throw new Error("Relative sed addresses are valid only as range endings");
  default: {
    const _ex: never = address;
    throw new Error(`Unhandled sed address kind: ${_ex}`);
  }
  }
}

function matchesRangeEndAddress({
  runtimeCommand,
  lineNumber,
  line,
  isLastLine,
}: {
  runtimeCommand: SedRangeRuntimeCommand;
  lineNumber: number;
  line: string;
  isLastLine: boolean;
}): boolean {
  const endAddress = runtimeCommand.command.rangeEnd;
  if (endAddress === undefined) return false;

  switch (endAddress.kind) {
  case "relativeOffset": {
    const startLine = runtimeCommand.rangeStartLine;
    if (startLine === undefined) return false;
    const targetLine = addSedUnsigned64({
      left: BigInt(startLine),
      right: endAddress.count,
    });
    return BigInt(lineNumber) >= targetLine;
  }
  case "relativeModulo": {
    const startLine = runtimeCommand.rangeStartLine;
    if (startLine === undefined) return false;
    if (endAddress.modulus === 0n) return lineNumber >= startLine;
    const startLineValue = BigInt(startLine);
    const remainder = startLineValue % endAddress.modulus;
    const targetLine = addSedUnsigned64({
      left: startLineValue,
      right:
        remainder === 0n
          ? endAddress.modulus
          : endAddress.modulus - remainder,
    });
    return BigInt(lineNumber) >= targetLine;
  }
  case "line":
  case "last":
  case "zero":
  case "regex":
  case "lineStep":
    return matchesAddress({
      address: endAddress,
      lineNumber,
      line,
      isLastLine,
    });
  default: {
    const _ex: never = endAddress;
    throw new Error(`Unhandled sed range end kind: ${_ex}`);
  }
  }
}

export function commandApplies({
  runtimeCommand,
  lineNumber,
  line,
  isLastLine,
}: {
  runtimeCommand: SedRangeRuntimeCommand;
  lineNumber: number;
  line: string;
  isLastLine: boolean;
}): boolean {
  const { command } = runtimeCommand;
  let applies: boolean;
  if (command.rangeEnd === undefined) {
    applies = matchesAddress({
      address: command.address,
      lineNumber,
      line,
      isLastLine,
    });
  } else if (runtimeCommand.inRange) {
    const rangeEnd = command.rangeEnd;
    if (rangeEnd.kind === "line" && BigInt(lineNumber) > rangeEnd.lineNumber) {
      runtimeCommand.inRange = false;
      runtimeCommand.rangeEndedOnLine = rangeEnd.lineNumber;
      applies = false;
    } else {
      if (
        matchesRangeEndAddress({
          runtimeCommand,
          lineNumber,
          line,
          isLastLine,
        })
      ) {
        runtimeCommand.inRange = false;
        runtimeCommand.rangeEndedOnLine = BigInt(lineNumber);
      }
      applies = true;
    }
  } else if (runtimeCommand.rangeEndedOnLine === BigInt(lineNumber)) {
    applies = true;
  } else {
    const startsRange = (() => {
      const address = command.address;
      if (address === undefined) return true;
      switch (address.kind) {
      case "zero":
        return !runtimeCommand.rangeStarted;
      case "line": {
        if (runtimeCommand.rangeStarted || BigInt(lineNumber) < address.lineNumber)
          return false;
        if (BigInt(lineNumber) === address.lineNumber) return true;
        const rangeEnd = command.rangeEnd;
        return rangeEnd.kind !== "line" || BigInt(lineNumber) <= rangeEnd.lineNumber;
      }
      case "last":
      case "regex":
      case "lineStep":
        return matchesAddress({
          address,
          lineNumber,
          line,
          isLastLine,
        });
      case "relativeOffset":
      case "relativeModulo":
        throw new Error("Relative sed addresses cannot start a range");
      default: {
        const _ex: never = address;
        throw new Error(
          `Unhandled sed range start kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
        );
      }
      }
    })();
    if (!startsRange) {
      applies = false;
    } else {
      if (command.address?.kind === "line" || command.address?.kind === "zero") {
        runtimeCommand.rangeStarted = true;
      }
      runtimeCommand.rangeEndedOnLine = undefined;
      runtimeCommand.rangeStartLine = lineNumber;
      const endAddress = command.rangeEnd;
      const endsOnStartingLine = (() => {
        if (isZeroSedAddress({ address: command.address })) {
          return matchesAddress({
            address: endAddress,
            lineNumber,
            line,
            isLastLine,
          });
        }
        switch (endAddress.kind) {
        case "regex":
          return false;
        case "lineStep":
          if (endAddress.first === 0n && endAddress.step === 0n) return true;
          return matchesAddress({
            address: endAddress,
            lineNumber,
            line,
            isLastLine,
          });
        case "line":
          return BigInt(lineNumber) >= endAddress.lineNumber;
        case "last":
          return isLastLine;
        case "zero":
          return true;
        case "relativeOffset":
          return endAddress.count === 0n;
        case "relativeModulo":
          return endAddress.modulus === 0n;
        default: {
          const _ex: never = endAddress;
          throw new Error(
            `Unhandled sed range end kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
          );
        }
        }
      })();
      if (!endsOnStartingLine) {
        runtimeCommand.inRange = true;
      }
      applies = true;
    }
  }

  return command.negated ? !applies : applies;
}

export function commandNeedsLastLine({
  runtimeCommand,
  lineNumber,
  line,
}: {
  runtimeCommand: SedRangeRuntimeCommand;
  lineNumber: number;
  line: string;
}): boolean {
  const { command } = runtimeCommand;
  const addressNeedsLastLine = (() => {
    const address = command.address;
    if (address === undefined) return false;
    switch (address.kind) {
    case "last":
      return true;
    case "zero":
    case "line":
    case "regex":
    case "lineStep":
      return false;
    case "relativeOffset":
    case "relativeModulo":
      throw new Error("Relative sed addresses cannot start a range");
    default: {
      const _ex: never = address;
      throw new Error(
        `Unhandled sed address kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
      );
    }
    }
  })();

  if (command.rangeEnd === undefined) return addressNeedsLastLine;

  const rangeEndsOnLastLine = (() => {
    const rangeEnd = command.rangeEnd;
    switch (rangeEnd.kind) {
    case "last":
      return true;
    case "zero":
    case "line":
    case "regex":
    case "lineStep":
    case "relativeOffset":
    case "relativeModulo":
      return false;
    default: {
      const _ex: never = rangeEnd;
      throw new Error(
        `Unhandled sed range end kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
      );
    }
    }
  })();

  if (runtimeCommand.inRange) return rangeEndsOnLastLine;
  if (runtimeCommand.rangeEndedOnLine === BigInt(lineNumber)) return false;
  if (addressNeedsLastLine) return true;
  if (!rangeEndsOnLastLine) return false;

  const address = command.address;
  if (address === undefined) return true;
  switch (address.kind) {
  case "last":
    return true;
  case "zero":
    return !runtimeCommand.rangeStarted;
  case "line":
    return !runtimeCommand.rangeStarted && BigInt(lineNumber) >= address.lineNumber;
  case "regex":
  case "lineStep":
    return matchesAddress({
      address,
      lineNumber,
      line,
      isLastLine: false,
    });
  case "relativeOffset":
  case "relativeModulo":
    throw new Error("Relative sed addresses cannot start a range");
  default: {
    const _ex: never = address;
    throw new Error(
      `Unhandled sed range start kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
    );
  }
  }
}

export function settleActiveRangeEnds({
  runtimeCommands,
  startIndex,
  endIndex,
  lineNumber,
  line,
  reason,
}: {
  runtimeCommands: readonly SedRangeRuntimeCommand[];
  startIndex: number;
  endIndex: number;
  lineNumber: number;
  line: string;
  reason: "cycleTermination" | "inputConsumption";
}): void {
  for (let index = startIndex; index < endIndex; index += 1) {
    const runtimeCommand = runtimeCommands[index]!;
    const rangeEnd = runtimeCommand.command.rangeEnd;
    if (!runtimeCommand.inRange || rangeEnd === undefined) continue;
    if (
      rangeEnd.kind === "last" ||
      rangeEnd.kind === "relativeOffset" ||
      rangeEnd.kind === "relativeModulo" ||
      (reason === "inputConsumption" &&
        (rangeEnd.kind === "regex" || rangeEnd.kind === "lineStep"))
    ) {
      continue;
    }
    if (matchesRangeEndAddress({
      runtimeCommand,
      lineNumber,
      line,
      isLastLine: false,
    })) {
      runtimeCommand.inRange = false;
      runtimeCommand.rangeEndedOnLine = BigInt(lineNumber);
    }
  }
}


export const TEST_ONLY = {
};
