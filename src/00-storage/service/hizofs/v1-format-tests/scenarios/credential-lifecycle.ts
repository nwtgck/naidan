import type { HizoFSV1FormatScenario } from "./scenario-types";

const text = ({ value }: { value: string }): Uint8Array => new TextEncoder().encode(value);

export const beforeCredentialReplacementScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "credential-before-replacement-v1",
  operations: Object.freeze([
    Object.freeze({
      bytes: text({ value: "before credential replacement\n" }),
      path: Object.freeze(["before.txt"]),
      type: "write_file" as const,
    }),
  ]),
});

export const afterCredentialReplacementScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "credential-after-replacement-v1",
  operations: Object.freeze([
    Object.freeze({ path: Object.freeze(["after"]), type: "mkdir" as const }),
    Object.freeze({
      bytes: text({ value: "after credential replacement\n" }),
      path: Object.freeze(["after", "after.txt"]),
      type: "write_file" as const,
    }),
  ]),
});

export const credentialReplacementObservableScenario: HizoFSV1FormatScenario = Object.freeze({
  id: "credential-replacement-observable-state-v1",
  operations: Object.freeze([
    ...beforeCredentialReplacementScenario.operations,
    ...afterCredentialReplacementScenario.operations,
  ]),
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
