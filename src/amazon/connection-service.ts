import { AmazonProvider } from "./amazon-provider.ts";
import { AmazonProviderError } from "./errors.ts";
import { cryptoIdGenerator, systemClock } from "./runtime.ts";
import type {
  AmazonConnectionInput,
  AmazonSellerCredentials,
  BeginConnectionResult,
  Clock,
  ConnectionEvent,
  ConnectionEventSink,
  ConnectionStatus,
  CredentialScope,
  CredentialVault,
  IdGenerator,
  LoginCallbackInput,
  PublicConnection,
  RedirectCallbackInput,
} from "./types.ts";

const BROWSER_SESSION_TTL_MS = 10 * 60 * 1_000;
const REDIRECT_STATE_TTL_MS = 5 * 60 * 1_000;

interface StoredConnection {
  publicConnection: PublicConnection;
  returnUrl: string;
  browserSessionId?: string;
  initialState?: string;
  loginHandled: boolean;
  sellingPartnerId?: string;
}

interface RedirectState {
  connectionId: string;
  sellingPartnerId: string;
  expiresAt: number;
  consumed: boolean;
}

interface BrowserSession {
  connectionId: string;
  expiresAt: number;
}

export interface AmazonConnectionServiceOptions {
  provider: AmazonProvider;
  credentialVault: CredentialVault;
  eventSink?: ConnectionEventSink;
  clock?: Clock;
  ids?: IdGenerator;
}

export class InMemoryConnectionEventSink implements ConnectionEventSink {
  public readonly events: ConnectionEvent[] = [];

  public async publish(event: ConnectionEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

/**
 * Internal Chameleon orchestration service. HTTP handlers should authenticate a
 * customer before calling beginConnection, and bind browserSessionId to a
 * Chameleon-owned Secure/HttpOnly cookie before calling handleLoginCallback.
 */
export class AmazonConnectionService {
  private readonly connections = new Map<string, StoredConnection>();
  private readonly browserSessions = new Map<string, BrowserSession>();
  private readonly redirectStates = new Map<string, RedirectState>();
  private readonly eventSink: ConnectionEventSink;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(private readonly options: AmazonConnectionServiceOptions) {
    this.eventSink = options.eventSink ?? new InMemoryConnectionEventSink();
    this.clock = options.clock ?? systemClock;
    this.ids = options.ids ?? cryptoIdGenerator;
  }

  public async beginConnection(input: AmazonConnectionInput): Promise<BeginConnectionResult> {
    assertSecureReturnUrl(input.returnUrl);
    const now = this.clock.now();
    const connectionId = this.ids.randomId("conn");
    const browserSessionId = this.ids.randomId("browser");
    const initialState = this.ids.randomId("state");
    const publicConnection: PublicConnection = {
      id: connectionId,
      environmentId: input.environmentId,
      organizationId: input.organizationId,
      provider: "amazon",
      status: "PENDING",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.connections.set(connectionId, {
      publicConnection,
      returnUrl: input.returnUrl,
      browserSessionId,
      initialState,
      loginHandled: false,
    });
    this.browserSessions.set(browserSessionId, {
      connectionId,
      expiresAt: now.getTime() + BROWSER_SESSION_TTL_MS,
    });
    await this.publish("connection.pending", publicConnection);

    return {
      connection: clone(publicConnection),
      authorizationUrl: this.options.provider.getAuthorizationUrl({ state: initialState }),
      browserSessionId,
    };
  }

  /**
   * First stage of Amazon's website authorization workflow. browserSessionId
   * must originate from Chameleon's own HttpOnly browser session cookie.
   */
  public async handleLoginCallback(input: LoginCallbackInput): Promise<{ confirmationUrl: string }> {
    const session = this.getActiveBrowserSession(input.browserSessionId);
    const connection = this.requireConnection(session.connectionId);
    if (connection.loginHandled) {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Amazon login callback was already handled.");
    }
    this.ensurePending(connection.publicConnection.status);

    const finalState = this.ids.randomId("state");
    const confirmationUrl = this.options.provider.createConfirmationUrl(
      {
        amazonCallbackUri: input.amazonCallbackUri,
        amazonState: input.amazonState,
        sellingPartnerId: input.sellingPartnerId,
        version: input.version,
      },
      finalState,
    );
    this.redirectStates.set(finalState, {
      connectionId: connection.publicConnection.id,
      sellingPartnerId: input.sellingPartnerId,
      expiresAt: this.clock.now().getTime() + REDIRECT_STATE_TTL_MS,
      consumed: false,
    });
    connection.loginHandled = true;
    connection.sellingPartnerId = input.sellingPartnerId;
    connection.publicConnection.updatedAt = this.clock.now().toISOString();
    return { confirmationUrl };
  }

  /** Exchanges a short-lived Connect Session capability for the provider redirect. */
  public startHostedConnect(browserSessionId: string): { authorizationUrl: string } {
    const session = this.getActiveBrowserSession(browserSessionId);
    const connection = this.requireConnection(session.connectionId);
    this.ensurePending(connection.publicConnection.status);
    if (!connection.initialState) {
      throw new AmazonProviderError("AMAZON_STATE_INVALID", "Amazon authorization state is unavailable.");
    }
    return {
      authorizationUrl: this.options.provider.getAuthorizationUrl({ state: connection.initialState }),
    };
  }

  /** Final stage of the callback flow, called by Chameleon's registered redirect URI. */
  public async completeRedirectCallback(input: RedirectCallbackInput): Promise<PublicConnection> {
    const callback = this.options.provider.parseRedirectCallback(input);
    const state = this.redirectStates.get(callback.state);
    if (!state) {
      throw new AmazonProviderError("AMAZON_STATE_INVALID", "Amazon redirect state does not exist.");
    }
    const connection = this.requireConnection(state.connectionId);

    if (state.consumed) {
      if (connection.publicConnection.status === "CONNECTED") {
        return clone(connection.publicConnection);
      }
      throw new AmazonProviderError("AMAZON_STATE_CONSUMED", "Amazon redirect state was already consumed.");
    }
    if (state.expiresAt <= this.clock.now().getTime()) {
      this.redirectStates.delete(callback.state);
      throw new AmazonProviderError("AMAZON_STATE_EXPIRED", "Amazon redirect state has expired.");
    }
    if (state.sellingPartnerId !== callback.sellingPartnerId) {
      throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Amazon seller ID does not match the authorization flow.");
    }
    this.ensurePending(connection.publicConnection.status);
    state.consumed = true;
    const scope = credentialScope(connection.publicConnection);

    try {
      let credentials = await this.options.credentialVault.get(connection.publicConnection.id, scope);
      if (!credentials) {
        const token = await this.options.provider.exchangeAuthorizationCode(callback.spapiOauthCode);
        credentials = {
          refreshToken: requiredRefreshToken(token.refresh_token),
          accessToken: token.access_token,
          accessTokenExpiresAt: expiresAt(this.clock.now(), token.expires_in),
        };
        await this.options.credentialVault.put(connection.publicConnection.id, scope, credentials);
      }
      if (!hasUsableAccessToken(credentials, this.clock.now())) {
        const token = await this.options.provider.refreshAccessToken(credentials.refreshToken);
        credentials = {
          refreshToken: token.refresh_token ?? credentials.refreshToken,
          accessToken: token.access_token,
          accessTokenExpiresAt: expiresAt(this.clock.now(), token.expires_in),
        };
        await this.options.credentialVault.put(connection.publicConnection.id, scope, credentials);
      }
      const participations = await this.options.provider.getMarketplaceParticipations(credentials.accessToken!);
      connection.publicConnection.account = this.options.provider.normalizeAccount(
        callback.sellingPartnerId,
        participations,
        this.ids.randomId("acct"),
      );
      this.transition(connection.publicConnection, "CONNECTED");
      await this.publish("connection.connected", connection.publicConnection);
      return clone(connection.publicConnection);
    } catch (cause) {
      const error = asAmazonError(cause);
      if (error.options.retryable) {
        // A retry can resume from the encrypted credentials if the code exchange
        // already succeeded, avoiding a second use of spapi_oauth_code.
        state.consumed = false;
      } else {
        this.transition(connection.publicConnection, "FAILED");
        await this.publish("connection.failed", connection.publicConnection);
      }
      throw error;
    }
  }

  public async refreshConnection(connectionId: string, environmentId: string, organizationId: string): Promise<void> {
    const connection = this.requireScopedConnection(connectionId, environmentId, organizationId);
    if (connection.publicConnection.status === "DISCONNECTED") {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Disconnected Amazon connections cannot refresh.");
    }
    const scope = credentialScope(connection.publicConnection);
    const credentials = await this.options.credentialVault.get(connectionId, scope);
    if (!credentials) {
      this.transition(connection.publicConnection, "REAUTHORIZATION_REQUIRED");
      await this.publish("connection.reauthorization_required", connection.publicConnection);
      throw new AmazonProviderError("AMAZON_CREDENTIALS_INVALID", "Amazon seller credentials are unavailable.");
    }

    try {
      const token = await this.options.provider.refreshAccessToken(credentials.refreshToken);
      await this.options.credentialVault.put(connectionId, scope, {
        refreshToken: token.refresh_token ?? credentials.refreshToken,
        accessToken: token.access_token,
        accessTokenExpiresAt: expiresAt(this.clock.now(), token.expires_in),
      });
    } catch (cause) {
      const error = asAmazonError(cause);
      if (!error.options.retryable) {
        this.transition(connection.publicConnection, "REAUTHORIZATION_REQUIRED");
        await this.publish("connection.reauthorization_required", connection.publicConnection);
      }
      throw error;
    }
  }

  public async reconnect(connectionId: string, environmentId: string, organizationId: string): Promise<BeginConnectionResult> {
    const existing = this.requireScopedConnection(connectionId, environmentId, organizationId);
    if (existing.publicConnection.status === "CONNECTED") {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Connected Amazon connection does not require reconnect.");
    }
    await this.options.credentialVault.delete(connectionId, credentialScope(existing.publicConnection));
    const browserSessionId = this.ids.randomId("browser");
    const initialState = this.ids.randomId("state");
    existing.browserSessionId = browserSessionId;
    existing.initialState = initialState;
    existing.loginHandled = false;
    delete existing.sellingPartnerId;
    delete existing.publicConnection.account;
    this.transition(existing.publicConnection, "PENDING");
    this.browserSessions.set(browserSessionId, {
      connectionId,
      expiresAt: this.clock.now().getTime() + BROWSER_SESSION_TTL_MS,
    });
    await this.publish("connection.pending", existing.publicConnection);
    return {
      connection: clone(existing.publicConnection),
      authorizationUrl: this.options.provider.getAuthorizationUrl({ state: initialState }),
      browserSessionId,
    };
  }

  public async disconnect(connectionId: string, environmentId: string, organizationId: string): Promise<PublicConnection> {
    const connection = this.requireScopedConnection(connectionId, environmentId, organizationId);
    if (connection.publicConnection.status === "DISCONNECTED") {
      return clone(connection.publicConnection);
    }
    await this.options.credentialVault.delete(connectionId, credentialScope(connection.publicConnection));
    this.transition(connection.publicConnection, "DISCONNECTED");
    await this.publish("connection.disconnected", connection.publicConnection);
    return clone(connection.publicConnection);
  }

  public getConnection(connectionId: string, environmentId: string, organizationId: string): PublicConnection {
    return clone(this.requireScopedConnection(connectionId, environmentId, organizationId).publicConnection);
  }

  /** Used by the authenticated Chameleon Backend API; never expose without environment authorization. */
  public getConnectionForEnvironment(connectionId: string, environmentId: string): PublicConnection {
    const connection = this.requireConnection(connectionId);
    if (connection.publicConnection.environmentId !== environmentId) {
      throw new AmazonProviderError("AMAZON_CONNECTION_NOT_FOUND", "Amazon connection was not found.");
    }
    return clone(connection.publicConnection);
  }

  /** Used by the authenticated Chameleon Backend API. */
  public async disconnectForEnvironment(connectionId: string, environmentId: string): Promise<PublicConnection> {
    const connection = this.getConnectionForEnvironment(connectionId, environmentId);
    return this.disconnect(connectionId, environmentId, connection.organizationId);
  }

  /** Used by the authenticated Chameleon Backend API. */
  public async reconnectForEnvironment(connectionId: string, environmentId: string): Promise<BeginConnectionResult> {
    const connection = this.getConnectionForEnvironment(connectionId, environmentId);
    return this.reconnect(connectionId, environmentId, connection.organizationId);
  }

  /** Internal only: resolves a pre-validated customer return URL after completion. */
  public getReturnUrl(connectionId: string): string {
    return this.requireConnection(connectionId).returnUrl;
  }

  private getActiveBrowserSession(browserSessionId: string): BrowserSession {
    const session = this.browserSessions.get(browserSessionId);
    if (!session || session.expiresAt <= this.clock.now().getTime()) {
      throw new AmazonProviderError("AMAZON_STATE_EXPIRED", "Amazon browser session is invalid or expired.");
    }
    return session;
  }

  private requireConnection(connectionId: string): StoredConnection {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      throw new AmazonProviderError("AMAZON_CONNECTION_NOT_FOUND", "Amazon connection was not found.");
    }
    return connection;
  }

  private requireScopedConnection(connectionId: string, environmentId: string, organizationId: string): StoredConnection {
    const connection = this.requireConnection(connectionId);
    if (
      connection.publicConnection.environmentId !== environmentId ||
      connection.publicConnection.organizationId !== organizationId
    ) {
      throw new AmazonProviderError("AMAZON_CONNECTION_NOT_FOUND", "Amazon connection was not found.");
    }
    return connection;
  }

  private ensurePending(status: ConnectionStatus): void {
    if (status !== "PENDING") {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Amazon connection is not awaiting authorization.");
    }
  }

  private transition(connection: PublicConnection, status: ConnectionStatus): void {
    connection.status = status;
    connection.updatedAt = this.clock.now().toISOString();
  }

  private async publish(type: ConnectionEvent["type"], connection: PublicConnection): Promise<void> {
    await this.eventSink.publish({
      type,
      connection: clone(connection),
      occurredAt: this.clock.now().toISOString(),
    });
  }
}

function requiredRefreshToken(value: string | undefined): string {
  if (!value) {
    throw new AmazonProviderError("AMAZON_TOKEN_EXCHANGE_FAILED", "Amazon did not return a refresh token.");
  }
  return value;
}

function credentialScope(connection: PublicConnection): CredentialScope {
  return {
    environmentId: connection.environmentId,
    organizationId: connection.organizationId,
    provider: "amazon",
  };
}

function expiresAt(now: Date, expiresInSeconds: number): string {
  return new Date(now.getTime() + expiresInSeconds * 1_000).toISOString();
}

function hasUsableAccessToken(credentials: AmazonSellerCredentials, now: Date): boolean {
  if (!credentials.accessToken || !credentials.accessTokenExpiresAt) {
    return false;
  }
  return new Date(credentials.accessTokenExpiresAt).getTime() > now.getTime() + 30_000;
}

function assertSecureReturnUrl(rawUrl: string): void {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") {
      throw new Error("non-HTTPS URL");
    }
  } catch (cause) {
    throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Return URL must be HTTPS and pre-validated by the API layer.", {
      cause,
    });
  }
}

function asAmazonError(cause: unknown): AmazonProviderError {
  if (cause instanceof AmazonProviderError) {
    return cause;
  }
  return new AmazonProviderError("AMAZON_PROVIDER_UNAVAILABLE", "Amazon connection could not be completed.", {
    retryable: true,
    cause,
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
