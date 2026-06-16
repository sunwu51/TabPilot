import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeStashSnapshots, updateStashTombstones } from "./merge";

describe("sync merge", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("keeps newer stash items from different devices", () => {
    const merged = mergeStashSnapshots(
      {
        local: { info: "本机", createdAt: 10, updatedAt: 20 }
      },
      {
        stashes: {
          remote: { info: "远端", createdAt: 11, updatedAt: 21 }
        }
      },
      {},
      { deviceId: "dev_a" }
    );

    expect(merged.snapshot.stashes.local.info).toBe("本机");
    expect(merged.snapshot.stashes.remote.info).toBe("远端");
  });

  it("uses updatedAt to resolve stash conflicts", () => {
    const merged = mergeStashSnapshots(
      {
        same: { info: "older", createdAt: 10, updatedAt: 20 }
      },
      {
        stashes: {
          same: { info: "newer", createdAt: 10, updatedAt: 30 }
        }
      },
      {},
      { deviceId: "dev_a" }
    );

    expect(merged.snapshot.stashes.same.info).toBe("newer");
  });

  it("prevents deleted local stash from being restored by remote stale data", () => {
    const merged = mergeStashSnapshots(
      {},
      {
        stashes: {
          stale: { info: "old", createdAt: 10, updatedAt: 20 }
        }
      },
      { stale: { deletedAt: 30 } },
      { deviceId: "dev_a" }
    );

    expect(merged.snapshot.stashes.stale).toBeUndefined();
  });

  it("records tombstones when stash items are removed", () => {
    vi.setSystemTime(1000);
    const tombstones = updateStashTombstones(
      { gone: { info: "x", updatedAt: 10 } },
      {},
      {}
    );

    expect(tombstones.gone.deletedAt).toBe(1000);
  });
});
