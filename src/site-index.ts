import { notFound } from "./lib/http";
import { withSecurityHeaders, redirectToHttps } from "./lib/transport-security";
import { handleSiteRequest } from "./routes/site";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const httpsRedirect = redirectToHttps(request);
    if (httpsRedirect) {
      return httpsRedirect;
    }

    const response = await handleSiteRequest(request, env, ctx);
    return withSecurityHeaders(response ?? notFound(), request);
  },
};
