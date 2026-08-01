import { describe, expect, it } from "vitest";
import { createBrowserContainerCoordinationScope } from "@/00-storage/service/hizofs/worker-entry";

describe("HizoFS worker entry", () => {
  it("derives the cross-realm scope from the canonical backing location", async () => {
    const scope = await createBrowserContainerCoordinationScope({
      canonicalBackingLocation: "naidan-storage/containerA",
    });

    expect(scope.token).toBe("P8ud6QzR9IEpVbimU1I09tS-cK8HBHqH5-iASJeI8Ow");
  });

  it("keeps byte-identical containers at different backing locations in separate scopes", async () => {
    const first = await createBrowserContainerCoordinationScope({
      canonicalBackingLocation: "naidan-storage/containerA",
    });
    const second = await createBrowserContainerCoordinationScope({
      canonicalBackingLocation: "naidan-storage/containerB",
    });

    expect(first.token).not.toBe(second.token);
    expect(first.key).not.toBe(second.key);
  });
});
