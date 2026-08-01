import {
  decodeBase64UrlUnpadded,
  encodeBase64UrlUnpadded,
} from "@/00-storage/service/hizofs/00-format";
import type { ContainerCoordinationKey } from "@/00-storage/service/hizofs/filesystem/container-coordination-key";

declare const containerCoordinationScopeTokenBrand: unique symbol;

export type ContainerCoordinationScopeToken = string & {
  readonly [containerCoordinationScopeTokenBrand]: true;
};

export type ContainerCoordinationScope = Readonly<{
  key: ContainerCoordinationKey;
  token: ContainerCoordinationScopeToken;
}>;

export type ContainerCoordinationScopeErrorCode =
  | "invalid_scope_token";

export class ContainerCoordinationScopeError extends Error {
  readonly code: ContainerCoordinationScopeErrorCode;

  constructor({ code, message }: { code: ContainerCoordinationScopeErrorCode; message: string }) {
    super(message);
    this.name = "ContainerCoordinationScopeError";
    this.code = code;
  }
}

export function parseContainerCoordinationScopeToken({ value }: {
  value: string;
}): ContainerCoordinationScopeToken {
  try {
    const bytes = decodeBase64UrlUnpadded({ maximumDecodedBytes: 32, value });
    if (bytes.byteLength !== 32) throw new Error("scope token must encode 32 bytes");
    return encodeBase64UrlUnpadded({ bytes }) as ContainerCoordinationScopeToken;
  } catch (cause: unknown) {
    throw new ContainerCoordinationScopeError({
      code: "invalid_scope_token",
      message: `container coordination scope token is not canonical Base64URL for 32 bytes: ${String(cause)}`,
    });
  }
}

/**
 * Creates one realm-local identity paired with a cross-realm namespace token.
 *
 * The token is derived by the backend integration from a canonical backing
 * location. It is runtime-only: it must never enter persisted bytes, key
 * derivation, authentication, or authorization decisions.
 */
export function createContainerCoordinationScope({ token }: {
  token: ContainerCoordinationScopeToken;
}): ContainerCoordinationScope {
  return Object.freeze({
    key: Object.freeze({}) as ContainerCoordinationKey,
    token,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
