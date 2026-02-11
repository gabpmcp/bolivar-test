import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqs } from "./aws.js";
import { config } from "../config.js";

export const enqueueEvent = (event: unknown) =>
  config.sqsQueueUrl
    ? sqs.send(
        new SendMessageCommand({
          QueueUrl: config.sqsQueueUrl,
          MessageBody: JSON.stringify(event)
        })
      )
    : Promise.resolve();
