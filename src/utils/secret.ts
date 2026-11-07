/** Kept off the instance so ordinary object inspection cannot enumerate the value. */
const values = new WeakMap<object, { value: unknown }>();
const MASKED = '[masked]';

// A type-only symbol brand survives mapped types (including Vue's unwrapping)
// without putting a payload, or even a branding property, on the instance.
declare const secretValueType: unique symbol;

/**
 * Prevent accidental disclosure, not deliberate access or memory inspection.
 * The wrapper is immutable, but an object-valued payload is not cloned or frozen.
 * Never use JSON/structuredClone to copy or transport a Secret: use explicit
 * domain copies or authorized DTO conversion and reconstruct it on receipt.
 */
export class Secret<T> {
  declare readonly [secretValueType]: () => T;

  private constructor({ value }: { value: T }) {
    values.set(this, { value });
    Object.freeze(this);
  }

  static from<T>({ value }: { value: T }): Secret<T> {
    return new Secret({ value });
  }

  /** Value equality, NOT constant-time authentication or structural equality. */
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Deliberately mirrors Object.is(left, right).
  static equals<T>(left: Secret<T>, right: Secret<T>): boolean {
    return Object.is(left.reveal(), right.reveal());
  }

  /** Use only at an explicit boundary that needs the original value. */
  reveal(): T {
    const entry = values.get(this);
    if (entry === undefined) {
      throw new TypeError('Invalid Secret receiver');
    }
    return entry.value as T;
  }

  toJSON(): string {
    return MASKED;
  }

  toString(): string {
    return MASKED;
  }

  [Symbol.toPrimitive](): string {
    return MASKED;
  }
}

export const TEST_ONLY = {
};
