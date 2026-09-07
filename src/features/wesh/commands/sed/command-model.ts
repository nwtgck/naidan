export type SedAddress =
  | { kind: "line"; lineNumber: bigint }
  | { kind: "last" }
  | { kind: "zero" }
  | { kind: "regex"; regex: RegExp }
  | { kind: "lineStep"; first: bigint; step: bigint }
  | { kind: "relativeOffset"; count: bigint }
  | { kind: "relativeModulo"; modulus: bigint };

export interface SedCommandSelection {
  address: SedAddress | undefined;
  rangeEnd: SedAddress | undefined;
  negated: boolean;
}

export type SedCommand = SedCommandSelection &
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
    | {
        kind: "translate";
        source: string;
        target: string;
        duplicateSourcePrecedence: "first" | "last";
      }
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
    | { kind: "branch"; targetLabel: string | undefined }
    | { kind: "branchIfSubstituted"; targetLabel: string | undefined }
    | { kind: "branchIfNotSubstituted"; targetLabel: string | undefined }
    | { kind: "groupStart"; endIndex: number }
    | { kind: "groupEnd" }
  );

export function isZeroSedAddress({
  address,
}: {
  address: SedAddress | undefined;
}): boolean {
  if (address === undefined) return false;
  switch (address.kind) {
  case "zero":
    return true;
  case "line":
  case "last":
  case "regex":
  case "lineStep":
  case "relativeOffset":
  case "relativeModulo":
    return false;
  default: {
    const _ex: never = address;
    throw new Error(
      `Unhandled sed address kind: ${(_ex satisfies never as { readonly kind: string }).kind}`,
    );
  }
  }
}


export const TEST_ONLY = {
};
