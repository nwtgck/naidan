import type { SedCommand, SedCommandSelection } from './command-model';
import type { SedRangeRuntimeState } from './range-runtime';

export type SedRuntimeExecutableCommand = SedCommandSelection &
  (
    | {
        kind: "substitute";
        regex: RegExp;
        replacement: string;
        occurrence: number;
        replaceFollowing: boolean;
        execute: boolean;
        printPhase: "none" | "afterSubstitution" | "afterExecution";
        writePath: string | undefined;
      }
    | { kind: "translate"; lookup: Map<string, string> }
    | { kind: "append"; text: string | undefined }
    | { kind: "insert"; text: string | undefined }
    | { kind: "change"; text: string | undefined }
    | { kind: "print" }
    | { kind: "printFirst" }
    | { kind: "list"; width: number | undefined }
    | { kind: "lineNumber" }
    | { kind: "hold" }
    | { kind: "holdAppend" }
    | { kind: "get" }
    | { kind: "getAppend" }
    | { kind: "exchange" }
    | { kind: "delete" }
    | { kind: "deleteFirst" }
    | { kind: "next" }
    | { kind: "nextAppend" }
    | { kind: "readFile"; path: string }
    | { kind: "readFileLine"; path: string }
    | { kind: "writeFile"; path: string }
    | { kind: "writeFileFirst"; path: string }
    | { kind: "clear" }
    | { kind: "fileName" }
    | { kind: "execute"; command: string | undefined }
    | { kind: "quit"; printPattern: boolean; exitCode: number }
    | { kind: "label"; name: string }
    | { kind: "branch"; targetIndex: number | undefined }
    | { kind: "branchIfSubstituted"; targetIndex: number | undefined }
    | { kind: "branchIfNotSubstituted"; targetIndex: number | undefined }
    | { kind: "groupStart"; targetIndex: number }
    | { kind: "groupEnd" }
  );

export interface SedExecutableRuntimeCommand extends SedRangeRuntimeState {
  command: SedRuntimeExecutableCommand;
}

export function createSedRuntimeCommands({
  commands,
}: {
  commands: SedCommand[];
}): SedExecutableRuntimeCommand[] {
  const labelIndices = new Map<string, number>();
  for (const [index, command] of commands.entries()) {
    switch (command.kind) {
    case "label":
      labelIndices.set(command.name, index);
      break;
    case "substitute":
    case "translate":
    case "append":
    case "insert":
    case "change":
    case "print":
    case "printFirst":
    case "list":
    case "lineNumber":
    case "hold":
    case "holdAppend":
    case "get":
    case "getAppend":
    case "exchange":
    case "delete":
    case "deleteFirst":
    case "next":
    case "nextAppend":
    case "readFile":
    case "readFileLine":
    case "writeFile":
    case "writeFileFirst":
    case "clear":
    case "fileName":
    case "execute":
    case "quit":
    case "branch":
    case "branchIfSubstituted":
    case "branchIfNotSubstituted":
    case "groupStart":
    case "groupEnd":
      break;
    default: {
      const _ex: never = command;
      throw new Error(
        `Unhandled sed command while collecting runtime labels: ${JSON.stringify(_ex)}`,
      );
    }
    }
  }

  return commands.map((command) => {
    switch (command.kind) {
    case "substitute":
      return {
        command: {
          kind: "substitute",
          address: command.address,
          rangeEnd: command.rangeEnd,
          negated: command.negated,
          regex: command.regex,
          replacement: command.replacement,
          occurrence: command.occurrence,
          replaceFollowing: command.replaceFollowing,
          execute: command.execute,
          printPhase: command.printPhase,
          writePath: command.writePath,
        },
        inRange: false,
        rangeStarted: false,
      };
    case "translate": {
      const sourceCharacters = command.source[Symbol.iterator]();
      const targetCharacters = command.target[Symbol.iterator]();
      const lookup = new Map<string, string>();
      while (true) {
        const sourceCharacter = sourceCharacters.next();
        if (sourceCharacter.done) break;
        const targetCharacter = targetCharacters.next();
        if (
          command.duplicateSourcePrecedence === "last" ||
          !lookup.has(sourceCharacter.value)
        ) {
          lookup.set(
            sourceCharacter.value,
            targetCharacter.done
              ? sourceCharacter.value
              : targetCharacter.value,
          );
        }
      }
      return {
        command: {
          kind: "translate",
          address: command.address,
          rangeEnd: command.rangeEnd,
          negated: command.negated,
          lookup,
        },
        inRange: false,
        rangeStarted: false,
      };
    }
    case "append":
    case "insert":
    case "change":
    case "print":
    case "printFirst":
    case "list":
    case "lineNumber":
    case "hold":
    case "holdAppend":
    case "get":
    case "getAppend":
    case "exchange":
    case "delete":
    case "deleteFirst":
    case "next":
    case "nextAppend":
    case "readFile":
    case "readFileLine":
    case "writeFile":
    case "writeFileFirst":
    case "clear":
    case "fileName":
    case "execute":
    case "quit":
    case "label":
    case "groupEnd":
      return {
        command,
        inRange: false,
        rangeStarted: false,
      };
    case "groupStart":
      return {
        command: {
          kind: "groupStart",
          address: command.address,
          rangeEnd: command.rangeEnd,
          negated: command.negated,
          targetIndex: command.endIndex + 1,
        },
        inRange: false,
        rangeStarted: false,
      };
    case "branch":
    case "branchIfSubstituted":
    case "branchIfNotSubstituted":
      return {
        command: {
          kind: command.kind,
          address: command.address,
          rangeEnd: command.rangeEnd,
          negated: command.negated,
          targetIndex:
              command.targetLabel === undefined
                ? undefined
                : labelIndices.get(command.targetLabel),
        },
        inRange: false,
        rangeStarted: false,
      };
    default: {
      const _ex: never = command;
      throw new Error(`Unhandled sed runtime command kind: ${_ex}`);
    }
    }
  });
}


export const TEST_ONLY = {
};
