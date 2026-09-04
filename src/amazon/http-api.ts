import { AmazonConnectionService } from "./connection-service.ts";
import { AmazonProviderError } from "./errors.ts";

export interface BackendAuthenticationContext {
  environmentId: string;
}

export interface BackendSecretKeyAuthenticator {
  authenticate(secretKey: string): Promise<BackendAuthenticationContext | undefined>;
}

export interface AmazonHostedApiOptions {
  connectionService: AmazonConnectionService;
  authenticateSecretKey: BackendSecretKeyAuthenticator;
  connectOrigin: string;
  isAllowedReturnUrl(input: { environmentId: string; organizationId: string; returnUrl: string }): boolean;
  now?: () => Date;
}

/** A test/reference authenticator. Production must hash and rotate Secret Keys in a persistent store. */
export class StaticSecretKeyAuthenticator implements BackendSecretKeyAuthenticator {
  public constructor(private readonly keys: ReadonlyMap<string, BackendAuthenticationContext>) {}

  public async authenticate(secretKey: string): Promise<BackendAuthenticationContext | undefined> {
    return this.keys.get(secretKey);
  }
}

/**
 * Framework-neutral Fetch handler for the Amazon vertical slice. Mount it in a
 * Node, Next.js, Hono, or edge adapter that supplies Request and Response.
 */
export function createAmazonHostedApi(options: AmazonHostedApiOptions): (request: Request) => Promise<Response> {
  const connectOrigin = new URL(options.connectOrigin);
  if (connectOrigin.protocol !== "https:") {
    throw new Error("connectOrigin must be HTTPS.");
  }
  const now = options.now ?? (() => new Date());

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/v1/connect_sessions" && request.method === "POST") {
        const context = await requireBackendAuthentication(request, options.authenticateSecretKey);
        const payload = await parseJsonBody(request);
        const organizationId = stringField(payload, "organizationId");
        const provider = stringField(payload, "provider");
        const returnUrl = stringField(payload, "returnUrl");
        if (provider !== "amazon") {
          return json({ code: "PROVIDER_UNAVAILABLE", message: "Provider is unavailable." }, 400);
        }
        if (!options.isAllowedReturnUrl({ environmentId: context.environmentId, organizationId, returnUrl })) {
          return json({ code: "RETURN_URL_INVALID", message: "Return URL is not allowed." }, 400);
        }
        const started = await options.connectionService.beginConnection({
          environmentId: context.environmentId,
          organizationId,
          returnUrl,
        });
        const connectUrl = new URL("/connect/amazon", connectOrigin);
        connectUrl.searchParams.set("connect_session", started.browserSessionId);
        return json(
          {
            id: `cs_${started.browserSessionId}`,
            connectionId: started.connection.id,
            connectUrl: connectUrl.toString(),
            connectSessionToken: started.browserSessionId,
            expiresAt: new Date(now().getTime() + 10 * 60 * 1_000).toISOString(),
          },
          201,
        );
      }

      const connectionRoute = /^\/v1\/connections\/([^/]+)(?:\/(disconnect|reconnect))?$/.exec(url.pathname);
      if (connectionRoute) {
        const context = await requireBackendAuthentication(request, options.authenticateSecretKey);
        const connectionId = decodeURIComponent(connectionRoute[1]!);
        const action = connectionRoute[2];
        if (request.method === "GET" && !action) {
          return json(options.connectionService.getConnectionForEnvironment(connectionId, context.environmentId));
        }
        if (request.method === "POST" && action === "disconnect") {
          return json(await options.connectionService.disconnectForEnvironment(connectionId, context.environmentId));
        }
        if (request.method === "POST" && action === "reconnect") {
          const reconnect = await options.connectionService.reconnectForEnvironment(connectionId, context.environmentId);
          const connectUrl = new URL("/connect/amazon", connectOrigin);
          connectUrl.searchParams.set("connect_session", reconnect.browserSessionId);
          return json({
            id: `cs_${reconnect.browserSessionId}`,
            connectionId: reconnect.connection.id,
            connectUrl: connectUrl.toString(),
            connectSessionToken: reconnect.browserSessionId,
            expiresAt: new Date(now().getTime() + 10 * 60 * 1_000).toISOString(),
          });
        }
      }

      if (url.pathname === "/connect/amazon" && request.method === "GET") {
        const connectSessionToken = url.searchParams.get("connect_session");
        if (!connectSessionToken) {
          return secureError("CONNECT_SESSION_INVALID", "Connect Session is missing.", 400);
        }
        const connect = options.connectionService.startHostedConnect(connectSessionToken);
        return redirect(connect.authorizationUrl, {
          "set-cookie": secureSessionCookie(connectSessionToken),
        });
      }

      if (url.pathname === "/v1/providers/amazon/login" && request.method === "GET") {
        const browserSessionId = readCookie(request.headers.get("cookie"), "chameleon_amazon_connect");
        if (!browserSessionId) {
          return secureError("CONNECT_SESSION_INVALID", "Connect Session is unavailable.", 400);
        }
        const confirmation = await options.connectionService.handleLoginCallback({
          browserSessionId,
          amazonCallbackUri: requiredSearchParam(url, "amazon_callback_uri"),
          amazonState: requiredSearchParam(url, "amazon_state"),
          sellingPartnerId: requiredSearchParam(url, "selling_partner_id"),
          version: url.searchParams.get("version") ?? undefined,
        });
        return redirect(confirmation.confirmationUrl);
      }

      if (url.pathname === "/v1/providers/amazon/callback" && request.method === "GET") {
        const connection = await options.connectionService.completeRedirectCallback({
          state: requiredSearchParam(url, "state"),
          sellingPartnerId: requiredSearchParam(url, "selling_partner_id"),
          spapiOauthCode: requiredSearchParam(url, "spapi_oauth_code"),
        });
        const returnUrl = new URL(options.connectionService.getReturnUrl(connection.id));
        returnUrl.searchParams.set("connection_id", connection.id);
        returnUrl.searchParams.set("connection_status", connection.status.toLowerCase());
        return redirect(returnUrl.toString(), {
          "set-cookie": expiredSessionCookie(),
        });
      }

      return json({ code: "NOT_FOUND", message: "Route not found." }, 404);
    } catch (cause) {
      return errorResponse(cause);
    }
  };
}

async function requireBackendAuthentication(
  request: Request,
  authenticator: BackendSecretKeyAuthenticator,
): Promise<BackendAuthenticationContext> {
  const authorization = request.headers.get("authorization");
  const match = authorization ? /^Bearer\s+(.+)$/.exec(authorization) : undefined;
  const context = match ? await authenticator.authenticate(match[1]!) : undefined;
  if (!context) {
    throw new AmazonProviderError("AMAZON_CREDENTIALS_INVALID", "Chameleon Secret Key is invalid.");
  }
  return context;
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("JSON body is not an object.");
    }
    return body as Record<string, unknown>;
  } catch (cause) {
    throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Request body must be a JSON object.", { cause });
  }
}

function stringField(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", `${name} must be a non-empty string.`);
  }
  return value;
}

function requiredSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) {
    throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", `Amazon callback is missing ${name}.`);
  }
  return value;
}

function readCookie(rawCookie: string | null, name: string): string | undefined {
  if (!rawCookie) {
    return undefined;
  }
  const match = rawCookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

function secureSessionCookie(value: string): string {
  return `chameleon_amazon_connect=${encodeURIComponent(value)}; Path=/v1/providers/amazon; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

function expiredSessionCookie(): string {
  return "chameleon_amazon_connect=; Path=/v1/providers/amazon; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "referrer-policy": "no-referrer",
    },
  });
}

function redirect(location: string, additionalHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location,
      "referrer-policy": "no-referrer",
      ...additionalHeaders,
    },
  });
}

function secureError(code: string, message: string, status: number): Response {
  return json({ code, message }, status);
}

function errorResponse(cause: unknown): Response {
  if (cause instanceof AmazonProviderError) {
    const status =
      cause.code === "AMAZON_CONNECTION_NOT_FOUND"
        ? 404
        : cause.code === "AMAZON_CONNECTION_CONFLICT" || cause.code === "AMAZON_STATE_CONSUMED"
          ? 409
          : cause.code === "AMAZON_RATE_LIMITED"
            ? 429
            : cause.options.retryable
              ? 503
              : 400;
    const headers: Record<string, string> = {};
    if (cause.options.retryAfterMs) {
      headers["retry-after"] = String(Math.ceil(cause.options.retryAfterMs / 1_000));
    }
    return new Response(
      JSON.stringify({
        code: cause.code,
        message: cause.message,
        requestId: cause.options.requestId,
      }),
      {
        status,
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
          "referrer-policy": "no-referrer",
          ...headers,
        },
      },
    );
  }
  return json({ code: "INTERNAL_ERROR", message: "An internal error occurred." }, 500);
}
