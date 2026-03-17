import { notFound } from "./lib/http";
import { handleEmail } from "./handlers/email";
import { handleQueue } from "./handlers/queues";
import { handleScheduled } from "./handlers/scheduled";
import { handleApiRequest } from "./routes/api";
import { handleSiteRequest } from "./routes/site";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const siteResponse = await handleSiteRequest(request, env, ctx);
    if (siteResponse) {
      return siteResponse;
    }

    const response = await handleApiRequest(request, env, ctx);
    return response ?? notFound();
  },

  async email(message: Parameters<typeof handleEmail>[0], env: Env): Promise<void> {
    await handleEmail(message, env);
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await handleScheduled(event, env);
  },
};
