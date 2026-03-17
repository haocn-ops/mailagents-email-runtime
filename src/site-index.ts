import { notFound } from "./lib/http";
import { handleSiteRequest } from "./routes/site";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await handleSiteRequest(request, env, ctx);
    return response ?? notFound();
  },
};
