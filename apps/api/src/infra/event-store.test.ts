import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn()
}));

vi.mock("./aws.js", () => ({
  s3: { send: sendMock }
}));

import {
  StreamGapDetectedError,
  getLatestSnapshot,
  loadStreamWithGapRetry,
  putSnapshot
} from "./event-store.js";

const bodyOf = (value: unknown) => ({
  transformToString: () => Promise.resolve(JSON.stringify(value))
});

describe("event-store snapshots and gaps", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("lee el latest snapshot por stream", async () => {
    sendMock.mockImplementation((command: { input: { Prefix?: string; Key?: string } }) =>
      command.input.Prefix
        ? Promise.resolve({
            Contents: [
              { Key: "snapshots/resource/r-1/000000000001.json" },
              { Key: "snapshots/resource/r-1/000000000005.json" }
            ],
            IsTruncated: false
          })
        : Promise.resolve({
            Body: bodyOf({
              streamType: "resource",
              streamId: "r-1",
              snapshotVersion: 5,
              lastEventVersion: 5,
              state: { status: "ok" },
              createdAtUtc: "2026-01-01T00:00:00.000Z"
            })
          })
    );

    const snapshot = await getLatestSnapshot<{ status: string }>("resource", "r-1");
    expect(snapshot?.snapshotVersion).toBe(5);
    expect(snapshot?.lastEventVersion).toBe(5);
    expect(snapshot?.state.status).toBe("ok");
  });

  it("escribe snapshot en s3 con metadata de versión", async () => {
    sendMock.mockResolvedValue({});

    await putSnapshot({
      streamType: "resource",
      streamId: "r-1",
      snapshotVersion: 10,
      lastEventVersion: 10,
      state: { count: 1 },
      createdAtUtc: "2026-01-01T00:00:00.000Z"
    });

    const putInput = sendMock.mock.calls[0][0].input;
    expect(putInput.Key).toBe("snapshots/resource/r-1/000000000010.json");
    expect(putInput.Metadata.snapshotversion).toBe("10");
    expect(putInput.Metadata.lasteventversion).toBe("10");
  });

  it("reintenta una vez y falla si persiste gap", async () => {
    sendMock.mockImplementation((command: { input: { Prefix?: string; Key?: string } }) =>
      command.input.Prefix
        ? Promise.resolve({
            Contents: [
              { Key: "resource/r-1/000000000001.json" },
              { Key: "resource/r-1/000000000003.json" }
            ],
            IsTruncated: false
          })
        : Promise.resolve({
            Body: bodyOf(
              (command.input.Key ?? "").endsWith("000000000001.json")
                ? {
                    eventId: "e1",
                    streamId: "r-1",
                    streamType: "resource",
                    version: 1,
                    type: "ResourceCreated",
                    occurredAtUtc: "2026-01-01T00:00:00.000Z",
                    payload: { resourceId: "r-1", name: "A", details: "D" },
                    meta: {}
                  }
                : {
                    eventId: "e3",
                    streamId: "r-1",
                    streamType: "resource",
                    version: 3,
                    type: "ResourceMetadataUpdated",
                    occurredAtUtc: "2026-01-01T00:00:01.000Z",
                    payload: { resourceId: "r-1", details: "X" },
                    meta: {}
                  }
            )
          })
    );

    await expect(loadStreamWithGapRetry("resource", "r-1", 1)).rejects.toBeInstanceOf(
      StreamGapDetectedError
    );
    const listCalls = sendMock.mock.calls.filter((call) => Boolean(call[0].input.Prefix));
    expect(listCalls.length).toBe(2);
  });
});
