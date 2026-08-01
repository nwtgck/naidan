import { describe, expect, it } from "vitest";
import { ExplicitBulkLifecycle, ExplicitBulkLifecycleError } from "@/00-storage/service/hizofs/filesystem/bulk/explicit-bulk-lifecycle";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("explicit bulk lifecycle", () => {
  it("requires a mutable live owner and a fresh empty target directory", () => {
    expect(() => new ExplicitBulkLifecycle({ ownerView: "fixed_read_view", target: { empty: true, fresh: true } })).toThrow(ExplicitBulkLifecycleError);
    expect(() => new ExplicitBulkLifecycle({ ownerView: "mutable_live", target: { empty: false, fresh: true } })).toThrow("fresh and empty");
    expect(() => new ExplicitBulkLifecycle({ ownerView: "mutable_live", target: { empty: true, fresh: false } })).toThrow("fresh and empty");
  });

  it("rejects overlapping mutations and aborts after an operation failure", async () => {
    const lifecycle = new ExplicitBulkLifecycle({ ownerView: "mutable_live", target: { empty: true, fresh: true } });
    const hold = deferred();
    const active = lifecycle.runMutation({ operation: async ({ assertActive }) => {
      await hold.promise;
      assertActive();
    } });
    await expect(lifecycle.runMutation({ operation: async () => undefined })).rejects.toMatchObject({ code: "operation_in_progress" });
    hold.resolve();
    await active;
    await expect(lifecycle.runMutation({ operation: async () => {
      throw new Error("candidate failed");
    } })).rejects.toThrow("candidate failed");
    expect(lifecycle.state()).toBe("aborted");
    await expect(lifecycle.commit({ publication: async () => undefined })).rejects.toMatchObject({ code: "builder_aborted" });
  });

  it("revokes an active operation when the owner starts closing", async () => {
    const lifecycle = new ExplicitBulkLifecycle({ ownerView: "mutable_live", target: { empty: true, fresh: true } });
    const hold = deferred();
    const active = lifecycle.runMutation({ operation: async ({ assertActive }) => {
      await hold.promise;
      assertActive();
    } });
    lifecycle.ownerClose();
    hold.resolve();
    await expect(active).rejects.toMatchObject({ code: "capability_revoked" });
    expect(lifecycle.state()).toBe("revoked");
  });

  it("checks revocation immediately before publication and rejects reuse after commit", async () => {
    const lifecycle = new ExplicitBulkLifecycle({ ownerView: "mutable_live", target: { empty: true, fresh: true } });
    let publicationCalls = 0;
    await lifecycle.commit({ publication: async ({ assertPublicationAllowed }) => {
      assertPublicationAllowed();
      publicationCalls += 1;
    } });
    expect(publicationCalls).toBe(1);
    expect(lifecycle.state()).toBe("committed");
    await expect(lifecycle.commit({ publication: async () => undefined })).rejects.toMatchObject({ code: "builder_committed" });
    await expect(lifecycle.runMutation({ operation: async () => undefined })).rejects.toMatchObject({ code: "builder_committed" });
  });

  it("does not revoke publication after the final gate transfers authority", async () => {
    const lifecycle = new ExplicitBulkLifecycle({ ownerView: "mutable_live", target: { empty: true, fresh: true } });
    let published = false;
    await lifecycle.commit({ publication: async ({ assertPublicationAllowed }) => {
      assertPublicationAllowed();
      lifecycle.ownerClose();
      published = true;
    } });
    expect(published).toBe(true);
    expect(lifecycle.state()).toBe("committed");
  });

  it("becomes terminal when publication fails after the authority gate", async () => {
    const lifecycle = new ExplicitBulkLifecycle({ ownerView: "mutable_live", target: { empty: true, fresh: true } });
    await expect(lifecycle.commit({ publication: async ({ assertPublicationAllowed }) => {
      assertPublicationAllowed();
      throw new Error("publication outcome requires resolution");
    } })).rejects.toThrow("publication outcome requires resolution");
    expect(lifecycle.state()).toBe("failed");
    await expect(lifecycle.commit({ publication: async () => undefined })).rejects.toMatchObject({ code: "builder_failed" });
  });

  it("does not publish when owner close wins before the final gate", async () => {
    const lifecycle = new ExplicitBulkLifecycle({ ownerView: "mutable_live", target: { empty: true, fresh: true } });
    let published = false;
    await expect(lifecycle.commit({ publication: async ({ assertPublicationAllowed }) => {
      lifecycle.ownerClose();
      assertPublicationAllowed();
      published = true;
    } })).rejects.toMatchObject({ code: "capability_revoked" });
    expect(published).toBe(false);
    expect(lifecycle.state()).toBe("revoked");
  });
});
