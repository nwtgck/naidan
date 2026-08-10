import { describe, expect, it } from "vitest";
import {
  allocateAuthenticatedHizoFSPhysicalBytes,
  authenticatedHizoFSPhysicalBytes,
} from "@/00-storage/service/hizofs/authenticated-store/physical-bytes";

describe("authenticated HizoFS physical byte ownership", () => {
  it("defensively copies bytes imported across the ownership boundary", () => {
    const source = Uint8Array.of(1, 2, 3, 4);
    const owned = authenticatedHizoFSPhysicalBytes({ bytes: source });

    source.fill(9);

    expect(Array.from(owned)).toEqual([1, 2, 3, 4]);
  });

  it("allocates a fresh owned destination with the requested byte length", () => {
    const owned = allocateAuthenticatedHizoFSPhysicalBytes({ byteLength: 4 });

    owned.set([1, 2, 3, 4]);

    expect(Array.from(owned)).toEqual([1, 2, 3, 4]);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid allocation length %s", byteLength => {
    expect(() => allocateAuthenticatedHizoFSPhysicalBytes({ byteLength })).toThrow(RangeError);
  });
});
