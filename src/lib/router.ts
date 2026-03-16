import type { RouteContext } from "../types";

export type RouteHandler<Env> = (request: Request, env: Env, ctx: ExecutionContext, route: RouteContext) => Promise<Response> | Response;

interface RouteDefinition<Env> {
  method: string;
  pattern: URLPattern;
  handler: RouteHandler<Env>;
}

export class Router<Env> {
  private readonly routes: RouteDefinition<Env>[] = [];

  on(method: string, pathname: string, handler: RouteHandler<Env>): void {
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new URLPattern({ pathname }),
      handler,
    });
  }

  async handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
    const url = new URL(request.url);

    for (const route of this.routes) {
      if (route.method !== request.method.toUpperCase()) {
        continue;
      }

      const match = route.pattern.exec({ pathname: url.pathname });
      if (!match) {
        continue;
      }

      return await route.handler(request, env, ctx, {
        params: match.pathname.groups,
        url,
      });
    }

    return null;
  }
}
