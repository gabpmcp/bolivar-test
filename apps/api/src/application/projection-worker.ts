import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { config } from "../config.js";
import { sqs } from "../infra/aws.js";
import { project } from "../projections/projector.js";
import { applyProjectionOps, upsertProjectionLag } from "../projections/store.js";
import type { RecordedEvent } from "../domain/types.js";

type QueueMessage = {
  Body?: string;
  ReceiptHandle?: string;
};

export const makeProcessBatch =
  (deps: {
    readMessages: () => Promise<{ Messages?: QueueMessage[] }>;
    deleteMessage: (receiptHandle: string) => Promise<void>;
    parseEvent: (message: QueueMessage) => Promise<RecordedEvent<string, Record<string, unknown>>>;
    project: (recordedEvent: RecordedEvent<string, Record<string, unknown>>) => ReturnType<typeof project>;
    applyProjectionOps: (ops: ReturnType<typeof project>) => Promise<void>;
    upsertProjectionLag: (lag: { lastProjectedAtUtc: string; eventsBehind: number }) => Promise<unknown>;
  }) =>
  () =>
    deps
      .readMessages()
      .then(({ Messages }) => Messages ?? [])
      .then((messages) =>
        Promise.all(
          messages.map((message) =>
            deps
              .parseEvent(message)
              .then((recordedEvent) =>
                deps
                  .applyProjectionOps(deps.project(recordedEvent))
                  .then(() =>
                    deps.upsertProjectionLag({
                      lastProjectedAtUtc: recordedEvent.occurredAtUtc,
                      eventsBehind: 0
                    })
                  )
              )
              .then(() =>
                message.ReceiptHandle
                  ? deps.deleteMessage(message.ReceiptHandle)
                  : Promise.resolve()
              )
              .catch(() => Promise.resolve())
          )
        )
      )
      .then(() => undefined);

export const makeWorkerLoop =
  (processBatch: () => Promise<void>) =>
  (): Promise<void> =>
    processBatch()
      .catch(() => undefined)
      .then(makeWorkerLoop(processBatch));

const readMessages = () =>
  sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: config.sqsQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20
    })
  );

const deleteMessage = (receiptHandle: string) =>
  sqs
    .send(
      new DeleteMessageCommand({
        QueueUrl: config.sqsQueueUrl,
        ReceiptHandle: receiptHandle
      })
    )
    .then(() => undefined);

const parseRecordedEvent = (message: QueueMessage) =>
  message.Body
    ? Promise.resolve(JSON.parse(message.Body) as RecordedEvent<string, Record<string, unknown>>)
    : Promise.reject(new Error("EMPTY_MESSAGE_BODY"));

export const processBatch = makeProcessBatch({
  readMessages,
  deleteMessage,
  parseEvent: parseRecordedEvent,
  project,
  applyProjectionOps,
  upsertProjectionLag
});

export const workerLoop = makeWorkerLoop(processBatch);

