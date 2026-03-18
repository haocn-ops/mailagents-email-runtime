import { notFound } from "./lib/http";
import { handleEmail } from "./handlers/email";
import { handleQueue } from "./handlers/queues";
import { handleScheduled } from "./handlers/scheduled";
import { ensureManagedContactAliasMailboxes } from "./lib/contact-aliases";
import { handleApiRequest } from "./routes/api";
import { handleMcpRequest } from "./routes/mcp";
import { handleSiteRequest } from "./routes/site";
import type { Env } from "./types";

let contactAliasBootstrapPromise: Promise<void> | null = null;

function ensureContactAliasesBootstrapped(env: Env): Promise<void> {
  if (!contactAliasBootstrapPromise) {
    contactAliasBootstrapPromise = ensureManagedContactAliasMailboxes(env).catch((error) => {
      contactAliasBootstrapPromise = null;
      throw error;
    });
  }

  return contactAliasBootstrapPromise;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await ensureContactAliasesBootstrapped(env);

    const mcpResponse = await handleMcpRequest(request, env, ctx);
    if (mcpResponse) {
      return mcpResponse;
    }

    const siteResponse = await handleSiteRequest(request, env, ctx);
    if (siteResponse) {
      return siteResponse;
    }

    const response = await handleApiRequest(request, env, ctx);
    return response ?? notFound();
  },

  async email(message: Parameters<typeof handleEmail>[0], env: Env): Promise<void> {
    await ensureContactAliasesBootstrapped(env);
    await handleEmail(message, env);
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await ensureContactAliasesBootstrapped(env);
    await handleQueue(batch, env);
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await ensureContactAliasesBootstrapped(env);
    await handleScheduled(event, env);
  },
};
