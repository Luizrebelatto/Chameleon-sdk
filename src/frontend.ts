import { ChameleonApiError, type ConnectSession, type CreateConnectSessionInput } from "./backend.ts";
import type { PublicConnection } from "./amazon/types.ts";
import type { ConnectionAttempt } from "./marketplace/types.ts";

export interface ChameleonFrontendClientOptions {
  publishableKey: string;
  /** A Chameleon-authenticated session proof. It is not a marketplace credential. */
  sessionToken?: string | (() => string | undefined | Promise<string | undefined>) | undefined;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export interface CreateFrontendConnectSessionInput extends Omit<CreateConnectSessionInput, "idempotencyKey"> {}

/**
 * Browser-safe client. It calls Chameleon's Frontend API with a publishable
 * key plus a Chameleon session proof; it never accepts a Secret Key or any
 * marketplace credential.
 */
export class ChameleonFrontendClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  public constructor(private readonly options: ChameleonFrontendClientOptions) {
    if (!options.publishableKey || options.publishableKey.trim().length === 0) {
      throw new Error("A Chameleon Publishable Key is required.");
    }
    this.baseUrl = (options.baseUrl ?? "https://api.chameleon.dev/v1").replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  public readonly connectSessions = {
    create: (input: CreateFrontendConnectSessionInput): Promise<ConnectSession> => this.createConnectSession(input),
  };

  public readonly connections = {
    get: (connectionId: string): Promise<PublicConnection> => this.request<PublicConnection>("GET", `/frontend/connections/${encodeURIComponent(connectionId)}`),
    disconnect: (connectionId: string): Promise<PublicConnection> =>
      this.request<PublicConnection>("POST", `/frontend/connections/${encodeURIComponent(connectionId)}/disconnect`),
    reconnect: (connectionId: string): Promise<ConnectSession> =>
      this.request<ConnectSession>("POST", `/frontend/connections/${encodeURIComponent(connectionId)}/reconnect`),
    selectResources: (connectionId: string, resourceIds: readonly string[]): Promise<PublicConnection> =>
      this.request<PublicConnection>("POST", `/frontend/connections/${encodeURIComponent(connectionId)}/resources`, { resourceIds }),
  };

  public readonly connectionAttempts = {
    get: (attemptId: string): Promise<ConnectionAttempt> =>
      this.request<ConnectionAttempt>("GET", `/frontend/connection_attempts/${encodeURIComponent(attemptId)}`),
    cancel: (attemptId: string): Promise<ConnectionAttempt> =>
      this.request<ConnectionAttempt>("POST", `/frontend/connection_attempts/${encodeURIComponent(attemptId)}/cancel`),
  };

  /**
   * The Clerk-like one-call interaction for a button. The caller supplies a
   * navigation function so this module also works in native webviews/tests.
   */
  public async connect(
    input: CreateFrontendConnectSessionInput,
    navigate: (url: string) => void = (url) => globalThis.location.assign(url),
  ): Promise<ConnectSession> {
    const session = await this.createConnectSession(input);
    navigate(session.connectUrl);
    return session;
  }

  private async createConnectSession(input: CreateFrontendConnectSessionInput): Promise<ConnectSession> {
    return this.request<ConnectSession>("POST", "/frontend/connect_sessions", input);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const sessionToken = await this.resolveSessionToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.publishableKey}`,
      accept: "application/json",
      "content-type": "application/json",
      "x-chameleon-client": "@chameleon/frontend/0.1.0",
    };
    if (sessionToken) {
      headers["x-chameleon-session"] = sessionToken;
    }
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const rawBody = await response.text();
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const parsed = safeJson(rawBody);
    if (!response.ok) {
      const message = typeof parsed?.message === "string" ? parsed.message : "Chameleon API request failed.";
      const code = typeof parsed?.code === "string" ? parsed.code : "CHAMELEON_API_ERROR";
      throw new ChameleonApiError(response.status, code, message, requestId);
    }
    if (!parsed) {
      throw new ChameleonApiError(response.status, "CHAMELEON_API_INVALID_RESPONSE", "Chameleon API returned invalid JSON.", requestId);
    }
    return parsed as unknown as T;
  }

  private async resolveSessionToken(): Promise<string | undefined> {
    const token = typeof this.options.sessionToken === "function" ? await this.options.sessionToken() : this.options.sessionToken;
    return token || undefined;
  }
}

export function createChameleonFrontendClient(options: ChameleonFrontendClientOptions): ChameleonFrontendClient {
  return new ChameleonFrontendClient(options);
}

function safeJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
