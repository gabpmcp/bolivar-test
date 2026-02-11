import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";

const { appendAndPublishMock, getLatestSnapshotMock, loadStreamWithGapRetryMock, putSnapshotMock } =
  vi.hoisted(() => ({
    appendAndPublishMock: vi.fn(),
    getLatestSnapshotMock: vi.fn(),
    loadStreamWithGapRetryMock: vi.fn(),
    putSnapshotMock: vi.fn()
  }));

vi.mock("./command-runner.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./command-runner.js")>();
  return {
    ...original,
    appendAndPublish: appendAndPublishMock
  };
});

vi.mock("../infra/event-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../infra/event-store.js")>();
  return {
    ...original,
    getLatestSnapshot: getLatestSnapshotMock,
    loadStreamWithGapRetry: loadStreamWithGapRetryMock,
    putSnapshot: putSnapshotMock
  };
});

import {
  loadStateFromSnapshotAndTail,
  appendResourceEventAndMaybeSnapshot
} from "./resource-workflow.js";

describe("resource-workflow snapshots", () => {
  const originalSnapshotPolicy = { ...config.snapshotByStreamType };

  beforeEach(() => {
    appendAndPublishMock.mockReset();
    getLatestSnapshotMock.mockReset();
    loadStreamWithGapRetryMock.mockReset();
    putSnapshotMock.mockReset();
    config.snapshotByStreamType.resource = 2;
  });

  afterEach(() => {
    config.snapshotByStreamType = { ...originalSnapshotPolicy };
  });

  it("carga estado desde snapshot + tail", async () => {
    getLatestSnapshotMock.mockResolvedValue({
      streamType: "resource",
      streamId: "r-1",
      snapshotVersion: 5,
      lastEventVersion: 5,
      state: { n: 10 },
      createdAtUtc: "2026-01-01T00:00:00.000Z"
    });
    loadStreamWithGapRetryMock.mockResolvedValue([
      {
        eventId: "e6",
        streamId: "r-1",
        streamType: "resource",
        version: 6,
        type: "Add",
        occurredAtUtc: "2026-01-01T00:00:01.000Z",
        payload: { inc: 2 },
        meta: {}
      },
      {
        eventId: "e7",
        streamId: "r-1",
        streamType: "resource",
        version: 7,
        type: "Add",
        occurredAtUtc: "2026-01-01T00:00:02.000Z",
        payload: { inc: 3 },
        meta: {}
      }
    ]);

    const result = await loadStateFromSnapshotAndTail({
      streamType: "resource",
      streamId: "r-1",
      initialState: { n: 0 },
      fold: (state, event: { type: string; payload: { inc: number } }) => ({
        n: state.n + event.payload.inc
      })
    });

    expect(loadStreamWithGapRetryMock).toHaveBeenCalledWith("resource", "r-1", 6);
    expect(result.state.n).toBe(15);
    expect(result.lastEventVersion).toBe(7);
  });

  it("escribe snapshot sincrónico al alcanzar umbral", async () => {
    appendAndPublishMock.mockImplementation((envelope: unknown) => Promise.resolve(envelope));
    putSnapshotMock.mockResolvedValue({});

    await appendResourceEventAndMaybeSnapshot({
      stateBefore: {
        resourceId: "r-1",
        name: "SalaA",
        details: "D1",
        status: "active",
        reservations: []
      },
      resourceId: "r-1",
      expectedVersion: 1,
      event: {
        type: "ResourceMetadataUpdated",
        payload: { resourceId: "r-1", details: "D2" }
      },
      commandName: "UpdateResourceMetadata",
      actorUserId: "u-1",
      success: () => ({ statusCode: 200, body: { ok: true } })
    });

    expect(putSnapshotMock).toHaveBeenCalledTimes(1);
    expect(putSnapshotMock.mock.calls[0][0].snapshotVersion).toBe(2);
    expect(putSnapshotMock.mock.calls[0][0].lastEventVersion).toBe(2);
  });
});
