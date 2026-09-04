import { AmazonConnectionService } from "./connection-service.ts";
import { AmazonProviderError } from "./errors.ts";
import { documentedMarketplaceAdapters } from "../marketplace/catalog.ts";
import { MarketplaceProviderRegistry } from "../marketplace/registry.ts";
import type { ConnectionAttempt, WorkspaceActor, WorkspaceAuthorizer, WorkspaceConnectionAction } from "../marketplace/types.ts";
import type { BeginConnectionResult, PublicConnection } from "./types.ts";

export interface BackendAuthenticationContext {
  environmentId: string;
  /** Present when the customer backend forwards a verified Chameleon actor. */
  actor?: WorkspaceActor | undefined;
}

export interface BackendSecretKeyAuthenticator {
  authenticate(secretKey: string): Promise<BackendAuthenticationContext | undefined>;
}

/**
 * A public key identifies an environment; the session proof identifies the
 * Chameleon user. Production implementations validate the proof against the
 * Chameleon session system before this handler sees a workspace id.
 */
export interface FrontendAuthenticationContext {
  environmentId: string;
  actor: WorkspaceActor;
}

export interface FrontendSessionAuthenticator {
  authenticate(input: { publishableKey: string; sessionToken?: string | undefined }): Promise<FrontendAuthenticationContext | undefined>;
}

export interface AmazonHostedApiOptions {
  connectionService: AmazonConnectionService;
  authenticateSecretKey: BackendSecretKeyAuthenticator;
  /** Enables the direct frontend SDK flow when supplied. */
  authenticateFrontendSession?: FrontendSessionAuthenticator | undefined;
  /**
   * Connect this to Chameleon workspace RBAC. Backend Secret Keys keep their
   * legacy trusted-server behavior only when this option is omitted.
   */
  workspaceAuthorizer?: WorkspaceAuthorizer | undefined;
  providerRegistry?: MarketplaceProviderRegistry | undefined;
  /** Exact customer origins allowed to call the browser-facing Frontend API. */
  isAllowedFrontendOrigin?: ((origin: string) => boolean) | undefined;
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

/** Test/reference public-session authenticator; never persist these plaintext maps in production. */
export class StaticFrontendSessionAuthenticator implements FrontendSessionAuthenticator {
  public constructor(private readonly sessions: ReadonlyMap<string, FrontendAuthenticationContext>) {}

  public async authenticate(input: {
    publishableKey: string;
    sessionToken?: string | undefined;
  }): Promise<FrontendAuthenticationContext | undefined> {
    return this.sessions.get(`${input.publishableKey}:${input.sessionToken ?? ""}`);
  }
}

/**
 * Framework-neutral Fetch handler. It has two separate trust boundaries:
 * Secret Key Backend API and Publishable Key + Chameleon session Frontend API.
 */
export function createAmazonHostedApi(options: AmazonHostedApiOptions): (request: Request) => Promise<Response> {
  const connectOrigin = new URL(options.connectOrigin);
  if (connectOrigin.protocol !== "https:") {
    throw new Error("connectOrigin must be HTTPS.");
  }
  const now = options.now ?? (() => new Date());
  const providerRegistry = options.providerRegistry ?? new MarketplaceProviderRegistry([
    { descriptor: options.connectionService.getProviderDescriptor() },
    ...documentedMarketplaceAdapters,
  ]);

  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/frontend/") && request.method === "OPTIONS") {
        return frontendPreflight(request, options);
      }
      if (url.pathname === "/v1/marketplaces" && request.method === "GET") {
        await requireBackendAuthentication(request, options.authenticateSecretKey);
        return json(providerRegistry.list());
      }
      if (url.pathname === "/v1/connect_sessions" && request.method === "POST") {
        const context = await requireBackendAuthentication(request, options.authenticateSecretKey);
        return await createConnectSessionResponse(request, context, "backend", options, connectOrigin, now);
      }

      if (url.pathname === "/v1/frontend/connect_sessions" && request.method === "POST") {
        assertAllowedFrontendOrigin(request, options);
        const context = await requireFrontendAuthentication(request, options.authenticateFrontendSession);
        return withFrontendCors(
          await createConnectSessionResponse(request, context, "frontend", options, connectOrigin, now),
          request,
        );
      }

      const frontendAttemptRoute = /^\/v1\/frontend\/connection_attempts\/([^/]+)(?:\/(cancel))?$/.exec(url.pathname);
      if (frontendAttemptRoute) {
        assertAllowedFrontendOrigin(request, options);
        const context = await requireFrontendAuthentication(request, options.authenticateFrontendSession);
        const attemptId = decodeURIComponent(frontendAttemptRoute[1]!);
        const action = frontendAttemptRoute[2];
        const attempt = options.connectionService.getAttemptForEnvironment(attemptId, context.environmentId);
        await authorizeWorkspace(
          options,
          context.actor,
          context.environmentId,
          attempt.organizationId,
          action ? "connection:cancel_attempt" : "connection:read",
          "frontend",
        );
        if (request.method === "GET" && !action) {
          return withFrontendCors(json(attempt), request);
        }
        if (request.method === "POST" && action === "cancel") {
          return withFrontendCors(
            json(await options.connectionService.cancelAttempt(attempt.id, context.environmentId, attempt.organizationId)),
            request,
          );
        }
      }

      const frontendResourcesRoute = /^\/v1\/frontend\/connections\/([^/]+)\/resources$/.exec(url.pathname);
      if (frontendResourcesRoute && request.method === "POST") {
        assertAllowedFrontendOrigin(request, options);
        const context = await requireFrontendAuthentication(request, options.authenticateFrontendSession);
        const connectionId = decodeURIComponent(frontendResourcesRoute[1]!);
        const connection = options.connectionService.getConnectionForEnvironment(connectionId, context.environmentId);
        await authorizeWorkspace(options, context.actor, context.environmentId, connection.organizationId, "connection:select_resources", "frontend");
        const payload = await parseJsonBody(request);
        return withFrontendCors(
          json(await options.connectionService.selectResourcesForEnvironment(connectionId, context.environmentId, stringArrayField(payload, "resourceIds"))),
          request,
        );
      }

      const frontendConnectionRoute = /^\/v1\/frontend\/connections\/([^/]+)(?:\/(disconnect|reconnect))?$/.exec(url.pathname);
      if (frontendConnectionRoute) {
        assertAllowedFrontendOrigin(request, options);
        const context = await requireFrontendAuthentication(request, options.authenticateFrontendSession);
        const connectionId = decodeURIComponent(frontendConnectionRoute[1]!);
        const action = frontendConnectionRoute[2];
        const connection = options.connectionService.getConnectionForEnvironment(connectionId, context.environmentId);
        const permission: WorkspaceConnectionAction =
          action === "disconnect" ? "connection:disconnect" : action === "reconnect" ? "connection:reconnect" : "connection:read";
        await authorizeWorkspace(options, context.actor, context.environmentId, connection.organizationId, permission, "frontend");
        if (request.method === "GET" && !action) {
          return withFrontendCors(json(connection), request);
        }
        if (request.method === "POST" && action === "disconnect") {
          return withFrontendCors(
            json(await options.connectionService.disconnectForEnvironment(connectionId, context.environmentId)),
            request,
          );
        }
        if (request.method === "POST" && action === "reconnect") {
          return withFrontendCors(
            json(connectSessionResponse(await options.connectionService.reconnectForEnvironment(connectionId, context.environmentId), connectOrigin, now)),
            request,
          );
        }
      }

      const attemptRoute = /^\/v1\/connection_attempts\/([^/]+)(?:\/(cancel))?$/.exec(url.pathname);
      if (attemptRoute) {
        const context = await requireBackendAuthentication(request, options.authenticateSecretKey);
        const attemptId = decodeURIComponent(attemptRoute[1]!);
        const action = attemptRoute[2];
        const attempt = options.connectionService.getAttemptForEnvironment(attemptId, context.environmentId);
        await authorizeWorkspace(options, context.actor, context.environmentId, attempt.organizationId, action ? "connection:cancel_attempt" : "connection:read", "backend");
        if (request.method === "GET" && !action) {
          return json(attempt);
        }
        if (request.method === "POST" && action === "cancel") {
          return json(await options.connectionService.cancelAttempt(attempt.id, context.environmentId, attempt.organizationId));
        }
      }

      const resourcesRoute = /^\/v1\/connections\/([^/]+)\/resources$/.exec(url.pathname);
      if (resourcesRoute && request.method === "POST") {
        const context = await requireBackendAuthentication(request, options.authenticateSecretKey);
        const connectionId = decodeURIComponent(resourcesRoute[1]!);
        const connection = options.connectionService.getConnectionForEnvironment(connectionId, context.environmentId);
        await authorizeWorkspace(options, context.actor, context.environmentId, connection.organizationId, "connection:select_resources", "backend");
        const payload = await parseJsonBody(request);
        const resourceIds = stringArrayField(payload, "resourceIds");
        return json(await options.connectionService.selectResourcesForEnvironment(connectionId, context.environmentId, resourceIds));
      }

      const connectionRoute = /^\/v1\/connections\/([^/]+)(?:\/(disconnect|reconnect))?$/.exec(url.pathname);
      if (connectionRoute) {
        const context = await requireBackendAuthentication(request, options.authenticateSecretKey);
        const connectionId = decodeURIComponent(connectionRoute[1]!);
        const action = connectionRoute[2];
        const connection = options.connectionService.getConnectionForEnvironment(connectionId, context.environmentId);
        const permission: WorkspaceConnectionAction =
          action === "disconnect" ? "connection:disconnect" : action === "reconnect" ? "connection:reconnect" : "connection:read";
        await authorizeWorkspace(options, context.actor, context.environmentId, connection.organizationId, permission, "backend");
        if (request.method === "GET" && !action) {
          return json(connection);
        }
        if (request.method === "POST" && action === "disconnect") {
          return json(await options.connectionService.disconnectForEnvironment(connectionId, context.environmentId));
        }
        if (request.method === "POST" && action === "reconnect") {
          const reconnect = await options.connectionService.reconnectForEnvironment(connectionId, context.environmentId);
          return json(connectSessionResponse(reconnect, connectOrigin, now));
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
        returnUrl.searchParams.set("attempt_id", options.connectionService.getActiveAttemptId(connection.id));
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

async function createConnectSessionResponse(
  request: Request,
  context: BackendAuthenticationContext | FrontendAuthenticationContext,
  source: "backend" | "frontend",
  options: AmazonHostedApiOptions,
  connectOrigin: URL,
  now: () => Date,
): Promise<Response> {
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
  await authorizeWorkspace(options, context.actor, context.environmentId, organizationId, "connection:create", source);
  const started = await options.connectionService.beginConnection({
    environmentId: context.environmentId,
    organizationId,
    returnUrl,
    initiatedByUserId: context.actor?.userId ?? `trusted-backend:${context.environmentId}`,
  });
  return json(connectSessionResponse(started, connectOrigin, now), 201);
}

function connectSessionResponse(started: BeginConnectionResult, connectOrigin: URL, now: () => Date): Record<string, unknown> {
  const connectUrl = new URL("/connect/amazon", connectOrigin);
  connectUrl.searchParams.set("connect_session", started.browserSessionId);
  return {
    id: `cs_${started.browserSessionId}`,
    attemptId: started.attempt.id,
    connectionId: started.connection.id,
    connectUrl: connectUrl.toString(),
    connectSessionToken: started.browserSessionId,
    expiresAt: new Date(now().getTime() + 10 * 60 * 1_000).toISOString(),
    state: started.attempt.status,
    nextAction: started.attempt.nextAction,
  };
}

async function authorizeWorkspace(
  options: AmazonHostedApiOptions,
  actor: WorkspaceActor | undefined,
  environmentId: string,
  organizationId: string,
  action: WorkspaceConnectionAction,
  source: "backend" | "frontend",
): Promise<void> {
  if (options.workspaceAuthorizer) {
    if (!actor) {
      throw new AmazonProviderError("AMAZON_AUTHORIZATION_DENIED", "A Chameleon user is required for this workspace action.");
    }
    await options.workspaceAuthorizer.assertAuthorized({ environmentId, organizationId, actor, action });
    return;
  }
  if (source === "frontend") {
    throw new AmazonProviderError("AMAZON_AUTHORIZATION_DENIED", "Workspace authorization is not configured.");
  }
  // Backwards-compatible trusted-server mode for the existing Secret Key API.
  // Production must supply workspaceAuthorizer to enforce user/role access.
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

function assertAllowedFrontendOrigin(request: Request, options: AmazonHostedApiOptions): void {
  const origin = request.headers.get("origin");
  if (origin && (!options.isAllowedFrontendOrigin || !options.isAllowedFrontendOrigin(origin))) {
    throw new AmazonProviderError("AMAZON_AUTHORIZATION_DENIED", "Frontend origin is not allowed.");
  }
}

function frontendPreflight(request: Request, options: AmazonHostedApiOptions): Response {
  const origin = request.headers.get("origin");
  if (!origin || !options.isAllowedFrontendOrigin || !options.isAllowedFrontendOrigin(origin)) {
    return secureError("FRONTEND_ORIGIN_INVALID", "Frontend origin is not allowed.", 403);
  }
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-chameleon-session",
      "access-control-max-age": "600",
      vary: "origin",
    },
  });
}

function withFrontendCors(response: Response, request: Request): Response {
  const origin = request.headers.get("origin");
  if (!origin) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "origin");
  return new Response(response.body, { status: response.status, headers });
}

async function requireFrontendAuthentication(
  request: Request,
  authenticator: FrontendSessionAuthenticator | undefined,
): Promise<FrontendAuthenticationContext> {
  const authorization = request.headers.get("authorization");
  const match = authorization ? /^Bearer\s+(.+)$/.exec(authorization) : undefined;
  const context = authenticator && match
    ? await authenticator.authenticate({
        publishableKey: match[1]!,
        sessionToken: request.headers.get("x-chameleon-session") ?? undefined,
      })
    : undefined;
  if (!context) {
    throw new AmazonProviderError("AMAZON_CREDENTIALS_INVALID", "Chameleon frontend session is invalid.");
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

function stringArrayField(payload: Record<string, unknown>, name: string): string[] {
  const value = payload[name];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", `${name} must be an array of non-empty strings.`);
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
        : cause.code === "AMAZON_AUTHORIZATION_DENIED"
          ? 403
          : cause.code === "AMAZON_CREDENTIALS_INVALID"
            ? 401
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
