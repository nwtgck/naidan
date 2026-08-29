import { describe, expect, it } from "vitest";
import type { NaidanSysfsRemoteChatMetaValue } from "./remote-reader-schema";

// eslint-disable-next-line local-rules/enforce-dependency-directions -- This test verifies the existing persistence DTO descriptor contract at the Worker transport boundary.
import {
  ExperimentalChatMetaSchemaDto,
  optionalExperimentalFieldSchemaDto,
} from "@/00-storage/00-dto/experimental.dto";

type RemoteExperimentalValue = NonNullable<NaidanSysfsRemoteChatMetaValue["experimental"]>;
type RemoteExperimentalHasUnreadable = "unreadable" extends keyof RemoteExperimentalValue ? true : false;
const remoteExperimentalHasUnreadable: RemoteExperimentalHasUnreadable = false;

describe("Naidan sysfs structured-clone view", () => {
  it("omits non-enumerable unreadable persistence metadata before the remote realm observes the value", () => {
    expect(remoteExperimentalHasUnreadable).toBe(false);
    const schema = optionalExperimentalFieldSchemaDto({
      schema: ExperimentalChatMetaSchemaDto,
    });
    const parsed = schema.parse({
      futureField: {
        callback: () => undefined,
      },
    });

    expect(parsed?.unreadable).toBeDefined();
    expect(Object.keys(parsed ?? {})).not.toContain("unreadable");

    const cloned = structuredClone(parsed);
    expect(cloned).toEqual({});
    expect(cloned === undefined ? false : "unreadable" in cloned).toBe(false);
  });
});
