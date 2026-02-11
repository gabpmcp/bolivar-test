import type { EventEnvelope } from "../domain/types.js";

export const foldFromEvents = <TState, TEvent extends { type: string; payload: unknown }>(
  events: EventEnvelope<TEvent["type"], TEvent["payload"]>[],
  initial: TState,
  fold: (state: TState, event: TEvent) => TState
) =>
  events.reduce(
    (state, envelope) =>
      fold(
        state,
        {
          type: envelope.type,
          payload: envelope.payload
        } as TEvent
      ),
    initial
  );
