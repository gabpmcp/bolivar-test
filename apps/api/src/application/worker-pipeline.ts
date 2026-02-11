import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { config } from "../config.js";
import { sqs } from "../infra/aws.js";
import { projectAndTrackLag } from "../projections/projector.js";
import type { EventEnvelope } from "../domain/types.js";

type QueueMessage = {
  Body?: string;
  ReceiptHandle?: string;
};

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

const parseEvent = (message: QueueMessage) =>
  message.Body
    ? Promise.resolve(JSON.parse(message.Body) as EventEnvelope<string, Record<string, unknown>>)
    : Promise.reject(new Error("EMPTY_MESSAGE_BODY"));

const projectMessage = (message: QueueMessage) =>
  parseEvent(message).then((event) => projectAndTrackLag(event));

const ackMessage = (message: QueueMessage) =>
  message.ReceiptHandle ? deleteMessage(message.ReceiptHandle) : Promise.resolve();

const processMessage = (message: QueueMessage) =>
  projectMessage(message)
    .then(() => ackMessage(message))
    .catch(() => Promise.resolve());

export const processBatch = () =>
  readMessages()
    .then(({ Messages }) => Messages ?? [])
    .then((messages) => Promise.all(messages.map(processMessage)));

export const workerLoop = (): Promise<void> =>
  processBatch()
    .then(() => undefined)
    .catch(() => undefined)
    .then(workerLoop);
