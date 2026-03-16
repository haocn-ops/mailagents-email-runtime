import type { DeadLetterJob, Env } from "../types";

export async function enqueueDeadLetter(env: Env, payload: DeadLetterJob): Promise<void> {
  await env.DEAD_LETTER_QUEUE.send(payload);
}
