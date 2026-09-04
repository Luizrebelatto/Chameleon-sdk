import type { PublicConnection } from "./amazon/types.ts";

export interface ChameleonBackendClientOptions {
  secretKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreateConnectSessionInput {
  organizationId: string;
  provider: "amazon";
  returnUrl: string;
  idempotencyKey?: string;
}

export interface ConnectSession {
  id: string;
  connectionId: string;
  connectUrl: string;
  connectSessionToken: string;
  expiresAt: string;
}

export class ChameleonApiError extends Error {
  public readonly name = "ChameleonApiError";

  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
  }
}

/**
 * The customer-facing, server-side client. It only calls Chameleon's Backend
 * API; Amazon client IDs, LWA tokens, SigV4 credentials, and callbacks remain
 * inside the Chameleon platform.
 */
export class ChameleonBackendClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  public readonly connectSessions = {
    create: (input: CreateConnectSessionInput): Promise<ConnectSession> => this.createConnectSession(input),
  };

  public readonly connections = {
    get: (connectionId: string): Promise<PublicConnection> => this.getConnection(connectionId),
    disconnect: (connectionId: string, idempotencyKey?: string): Promise<PublicConnection> =>
      this.disconnectConnection(connectionId, idempotencyKey),
    reconnect: (connectionId: string, idempotencyKey?: string): Promise<ConnectSession> =>
      this.reconnectConnection(connectionId, idempotencyKey),
  };

  public constructor(private readonly options: ChameleonBackendClientOptions) {
    if (!options.secretKey || options.secretKey.trim().length === 0) {
      throw new Error("A Chameleon Secret Key is required.");
    }
    this.baseUrl = (options.baseUrl ?? "https://api.chameleon.dev/v1").replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  private async createConnectSession(input: CreateConnectSessionInput): Promise<ConnectSession> {
    return this.request<ConnectSession>("POST", "/connect_sessions", input, input.idempotencyKey);
  }

  private async getConnection(connectionId: string): Promise<PublicConnection> {
    return this.request<PublicConnection>("GET", `/connections/${encodeURIComponent(connectionId)}`);
  }

  private async disconnectConnection(connectionId: string, idempotencyKey?: string): Promise<PublicConnection> {
    return this.request<PublicConnection>("POST", `/connections/${encodeURIComponent(connectionId)}/disconnect`, undefined, idempotencyKey);
  }

  private async reconnectConnection(connectionId: string, idempotencyKey?: string): Promise<ConnectSession> {
    return this.request<ConnectSession>("POST", `/connections/${encodeURIComponent(connectionId)}/reconnect`, undefined, idempotencyKey);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.secretKey}`,
      accept: "application/json",
      "user-agent": "@chameleon/backend/0.1.0",
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (idempotencyKey) {
      headers["idempotency-key"] = idempotencyKey;
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const response = await this.fetchImplementation(`${this.baseUrl}${path}`, init);
    const rawBody = await response.text();
    const requestId = response.headers.get("x-request-id") ?? undefined;
    if (!response.ok) {
      const parsed = safeJson(rawBody);
      const message = typeof parsed?.message === "string" ? parsed.message : "Chameleon API request failed.";
      const code = typeof parsed?.code === "string" ? parsed.code : "CHAMELEON_API_ERROR";
      throw new ChameleonApiError(response.status, code, message, requestId);
    }
    const parsed = safeJson(rawBody);
    if (!parsed) {
      throw new ChameleonApiError(response.status, "CHAMELEON_API_INVALID_RESPONSE", "Chameleon API returned invalid JSON.", requestId);
    }
    return parsed as T;
  }
}

export function createChameleonClient(options: ChameleonBackendClientOptions): ChameleonBackendClient {
  return new ChameleonBackendClient(options);
}

function safeJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
