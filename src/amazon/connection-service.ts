import { AmazonProvider } from "./amazon-provider.ts";
import { AmazonProviderError } from "./errors.ts";
import { cryptoIdGenerator, systemClock } from "./runtime.ts";
import type {
  ConnectionAttempt,
  ConnectionAttemptStatus,
  ConnectionIntent,
  ConnectionNextAction,
  MarketplacePermission,
  MarketplaceResource,
  SyncState,
} from "../marketplace/types.ts";
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
  MarketplaceParticipationsResponse,
  PublicConnection,
  RedirectCallbackInput,
} from "./types.ts";

const BROWSER_SESSION_TTL_MS = 10 * 60 * 1_000;
const REDIRECT_STATE_TTL_MS = 5 * 60 * 1_000;

interface StoredConnection {
  publicConnection: PublicConnection;
  returnUrl: string;
  activeAttemptId: string;
}

interface StoredAttempt {
  publicAttempt: ConnectionAttempt;
  browserSessionId: string;
  initialState: string;
  loginHandled: boolean;
  sellingPartnerId?: string | undefined;
  /** Previous seller identity, used to prevent a reconnect tenant mix-up. */
  expectedProviderAccountId?: string | undefined;
}

interface RedirectState {
  connectionId: string;
  attemptId: string;
  sellingPartnerId: string;
  expiresAt: number;
  consumed: boolean;
}

interface BrowserSession {
  connectionId: string;
  attemptId: string;
  expiresAt: number;
}

export interface AmazonConnectionServiceOptions {
  provider: AmazonProvider;
  credentialVault: CredentialVault;
  eventSink?: ConnectionEventSink;
  clock?: Clock;
  ids?: IdGenerator;
  /** A seller selects discovered resources before a connection becomes active. */
  requireResourceSelection?: boolean | undefined;
}

export class InMemoryConnectionEventSink implements ConnectionEventSink {
  public readonly events: ConnectionEvent[] = [];

  public async publish(event: ConnectionEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

/**
 * Internal Chameleon orchestration for Amazon. The reference implementation is
 * in-memory, but its boundaries map directly to ConnectionAttempt,
 * MarketplaceConnection, CredentialSet, MarketplaceResource, and SyncState
 * persistence in production.
 */
export class AmazonConnectionService {
  private readonly connections = new Map<string, StoredConnection>();
  private readonly attempts = new Map<string, StoredAttempt>();
  private readonly browserSessions = new Map<string, BrowserSession>();
  private readonly redirectStates = new Map<string, RedirectState>();
  private readonly externalAccountOwners = new Map<string, { organizationId: string; connectionId: string }>();
  private readonly refreshes = new Map<string, Promise<void>>();
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
    const publicConnection: PublicConnection = {
      id: connectionId,
      environmentId: input.environmentId,
      organizationId: input.organizationId,
      provider: "amazon",
      status: "PENDING",
      authorizationStatus: "PENDING",
      syncState: initialSyncState(now),
      resources: [],
      permissions: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const connection: StoredConnection = {
      publicConnection,
      returnUrl: input.returnUrl,
      activeAttemptId: "",
    };
    this.connections.set(connectionId, connection);
    const attempt = this.createAttempt(connection, {
      initiatedByUserId: input.initiatedByUserId ?? "service",
      intent: input.intent ?? "CONNECT",
    });
    await this.publish("connection.pending", publicConnection);
    return this.beginResult(connection, attempt);
  }

  /**
   * First stage of Amazon's website authorization workflow. browserSessionId
   * must originate from Chameleon's Secure/HttpOnly browser session cookie.
   */
  public async handleLoginCallback(input: LoginCallbackInput): Promise<{ confirmationUrl: string }> {
    const session = this.getActiveBrowserSession(input.browserSessionId);
    const connection = this.requireConnection(session.connectionId);
    const attempt = this.requireAttempt(session.attemptId);
    this.assertActiveAttempt(connection, attempt);
    this.ensureAttemptStatus(attempt, "awaiting_authorization");
    if (attempt.loginHandled) {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Amazon login callback was already handled.");
    }

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
      attemptId: attempt.publicAttempt.id,
      sellingPartnerId: input.sellingPartnerId,
      expiresAt: this.clock.now().getTime() + REDIRECT_STATE_TTL_MS,
      consumed: false,
    });
    attempt.loginHandled = true;
    attempt.sellingPartnerId = input.sellingPartnerId;
    this.transitionAttempt(attempt, "processing", "none");
    return { confirmationUrl };
  }

  /** Exchanges a short-lived Connect Session capability for the provider redirect. */
  public startHostedConnect(browserSessionId: string): { authorizationUrl: string } {
    const session = this.getActiveBrowserSession(browserSessionId);
    const connection = this.requireConnection(session.connectionId);
    const attempt = this.requireAttempt(session.attemptId);
    this.assertActiveAttempt(connection, attempt);
    this.ensureAttemptStatus(attempt, "awaiting_authorization");
    return { authorizationUrl: this.options.provider.getAuthorizationUrl({ state: attempt.initialState }) };
  }

  /** Final callback stage; no marketplace credentials leave this service. */
  public async completeRedirectCallback(input: RedirectCallbackInput): Promise<PublicConnection> {
    const callback = this.options.provider.parseRedirectCallback(input);
    const state = this.redirectStates.get(callback.state);
    if (!state) {
      throw new AmazonProviderError("AMAZON_STATE_INVALID", "Amazon redirect state does not exist.");
    }
    const connection = this.requireConnection(state.connectionId);
    const attempt = this.requireAttempt(state.attemptId);

    if (state.consumed) {
      if (attempt.publicAttempt.status === "completed" || attempt.publicAttempt.status === "awaiting_selection") {
        return clone(connection.publicConnection);
      }
      throw new AmazonProviderError("AMAZON_STATE_CONSUMED", "Amazon redirect state was already consumed.");
    }
    if (state.expiresAt <= this.clock.now().getTime()) {
      this.redirectStates.delete(callback.state);
      this.transitionAttempt(attempt, "expired", "retry", attemptError("AMAZON_STATE_EXPIRED", "Authorization has expired.", true));
      throw new AmazonProviderError("AMAZON_STATE_EXPIRED", "Amazon redirect state has expired.");
    }
    this.assertActiveAttempt(connection, attempt);
    if (state.sellingPartnerId !== callback.sellingPartnerId) {
      await this.failAttempt(connection, attempt, "AMAZON_CALLBACK_INVALID", "Amazon seller ID does not match the authorization flow.");
      throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Amazon seller ID does not match the authorization flow.");
    }
    if (attempt.expectedProviderAccountId && attempt.expectedProviderAccountId !== callback.sellingPartnerId) {
      await this.failAttempt(
        connection,
        attempt,
        "AMAZON_AUTHORIZATION_DENIED",
        "The authorized seller does not match the connection being reauthorized.",
      );
      throw new AmazonProviderError(
        "AMAZON_AUTHORIZATION_DENIED",
        "The authorized seller does not match the connection being reauthorized.",
      );
    }
    this.ensureConnectionCanProcess(connection.publicConnection.status);
    state.consumed = true;
    const stagedScope = credentialScope(connection.publicConnection, attempt.publicAttempt.id);

    try {
      let credentials = await this.options.credentialVault.get(connection.publicConnection.id, stagedScope);
      if (!credentials) {
        const token = await this.options.provider.exchangeAuthorizationCode(callback.spapiOauthCode);
        credentials = {
          refreshToken: requiredRefreshToken(token.refresh_token),
          accessToken: token.access_token,
          accessTokenExpiresAt: expiresAt(this.clock.now(), token.expires_in),
        };
        // New credentials remain attempt-scoped until seller identity and
        // accessible resources validate successfully.
        await this.options.credentialVault.put(connection.publicConnection.id, stagedScope, credentials);
      }
      if (!hasUsableAccessToken(credentials, this.clock.now())) {
        const token = await this.options.provider.refreshAccessToken(credentials.refreshToken);
        credentials = {
          refreshToken: token.refresh_token ?? credentials.refreshToken,
          accessToken: token.access_token,
          accessTokenExpiresAt: expiresAt(this.clock.now(), token.expires_in),
        };
        await this.options.credentialVault.put(connection.publicConnection.id, stagedScope, credentials);
      }
      const participations = await this.options.provider.getMarketplaceParticipations(credentials.accessToken!);
      this.assertExternalAccountAvailable(connection, callback.sellingPartnerId);
      connection.publicConnection.account = this.options.provider.normalizeAccount(
        callback.sellingPartnerId,
        participations,
        this.ids.randomId("acct"),
      );
      connection.publicConnection.resources = resourcesFromParticipations(
        callback.sellingPartnerId,
        participations,
        this.options.requireResourceSelection === true,
      );
      connection.publicConnection.permissions = knownAmazonPermissions();

      if (this.options.requireResourceSelection === true) {
        attempt.publicAttempt.availableResources = clone(connection.publicConnection.resources);
        attempt.publicAttempt.permissions = clone(connection.publicConnection.permissions);
        this.transitionAttempt(attempt, "awaiting_selection", "select_resources");
        this.touch(connection.publicConnection);
        return clone(connection.publicConnection);
      }

      await this.activateConnection(connection, attempt, credentials, stagedScope);
      return clone(connection.publicConnection);
    } catch (cause) {
      const error = asAmazonError(cause);
      if (error.options.retryable) {
        // Authorization codes are single-use. A retry resumes from encrypted,
        // staged credentials instead of submitting the code again.
        state.consumed = false;
        this.transitionAttempt(attempt, "processing", "retry", attemptError(error.code, error.message, true));
      } else {
        await this.options.credentialVault.delete(connection.publicConnection.id, stagedScope);
        await this.failAttempt(connection, attempt, error.code, error.message);
      }
      throw error;
    }
  }

  /** Completes an optional resource-selection stage without returning credentials. */
  public async selectResources(
    connectionId: string,
    environmentId: string,
    organizationId: string,
    resourceIds: readonly string[],
  ): Promise<PublicConnection> {
    const connection = this.requireScopedConnection(connectionId, environmentId, organizationId);
    const attempt = this.requireAttempt(connection.activeAttemptId);
    this.ensureAttemptStatus(attempt, "awaiting_selection");
    if (resourceIds.length === 0) {
      throw new AmazonProviderError("AMAZON_AUTHORIZATION_DENIED", "At least one authorized Amazon resource must be selected.");
    }
    const selected = new Set(resourceIds);
    const available = new Set(connection.publicConnection.resources.map((resource) => resource.id));
    if (selected.size !== resourceIds.length || [...selected].some((resourceId) => !available.has(resourceId))) {
      throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Amazon resource selection is invalid.");
    }
    connection.publicConnection.resources = connection.publicConnection.resources.map((resource) => ({
      ...resource,
      selected: selected.has(resource.id),
    }));
    attempt.publicAttempt.availableResources = clone(connection.publicConnection.resources);
    const stagedScope = credentialScope(connection.publicConnection, attempt.publicAttempt.id);
    const credentials = await this.options.credentialVault.get(connectionId, stagedScope);
    if (!credentials) {
      throw new AmazonProviderError("AMAZON_CREDENTIALS_INVALID", "Amazon authorization must be restarted before selecting resources.");
    }
    await this.activateConnection(connection, attempt, credentials, stagedScope);
    return clone(connection.publicConnection);
  }

  /** Coalesces refreshes per connection to prevent competing token rotation. */
  public async refreshConnection(connectionId: string, environmentId: string, organizationId: string): Promise<void> {
    const lockKey = `${environmentId}:${organizationId}:${connectionId}`;
    const existing = this.refreshes.get(lockKey);
    if (existing) {
      return existing;
    }
    const refresh = this.refreshConnectionInternal(connectionId, environmentId, organizationId);
    this.refreshes.set(lockKey, refresh);
    try {
      await refresh;
    } finally {
      if (this.refreshes.get(lockKey) === refresh) {
        this.refreshes.delete(lockKey);
      }
    }
  }

  public async reconnect(connectionId: string, environmentId: string, organizationId: string): Promise<BeginConnectionResult> {
    const existing = this.requireScopedConnection(connectionId, environmentId, organizationId);
    if (existing.publicConnection.status === "CONNECTED") {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Connected Amazon connection does not require reconnect.");
    }
    const expectedProviderAccountId = existing.publicConnection.account?.providerAccountId;
    const attempt = this.createAttempt(existing, {
      initiatedByUserId: "service",
      intent: "RECONNECT",
      ...(expectedProviderAccountId ? { expectedProviderAccountId } : {}),
    });
    delete existing.publicConnection.account;
    existing.publicConnection.resources = [];
    existing.publicConnection.permissions = [];
    this.transition(existing.publicConnection, "PENDING");
    await this.publish("connection.pending", existing.publicConnection);
    return this.beginResult(existing, attempt);
  }

  public async cancelAttempt(attemptId: string, environmentId: string, organizationId: string): Promise<ConnectionAttempt> {
    const attempt = this.requireAttempt(attemptId);
    if (attempt.publicAttempt.environmentId !== environmentId || attempt.publicAttempt.organizationId !== organizationId) {
      throw new AmazonProviderError("AMAZON_CONNECTION_NOT_FOUND", "Amazon connection attempt was not found.");
    }
    if (["completed", "failed", "cancelled", "expired"].includes(attempt.publicAttempt.status)) {
      return clone(attempt.publicAttempt);
    }
    const connection = this.requireConnection(attempt.publicAttempt.connectionId);
    await this.options.credentialVault.delete(connection.publicConnection.id, credentialScope(connection.publicConnection, attemptId));
    this.transitionAttempt(attempt, "cancelled", "none");
    if (connection.activeAttemptId === attemptId && connection.publicConnection.status === "PENDING") {
      this.transition(connection.publicConnection, "FAILED");
      await this.publish("connection.failed", connection.publicConnection);
    }
    return clone(attempt.publicAttempt);
  }

  public async disconnect(connectionId: string, environmentId: string, organizationId: string): Promise<PublicConnection> {
    const connection = this.requireScopedConnection(connectionId, environmentId, organizationId);
    if (connection.publicConnection.status === "DISCONNECTED") {
      return clone(connection.publicConnection);
    }
    await this.options.credentialVault.delete(connectionId, credentialScope(connection.publicConnection));
    await this.options.credentialVault.delete(
      connectionId,
      credentialScope(connection.publicConnection, connection.activeAttemptId),
    );
    const accountId = connection.publicConnection.account?.providerAccountId;
    if (accountId) {
      const key = externalAccountKey(connection.publicConnection, accountId);
      if (this.externalAccountOwners.get(key)?.connectionId === connectionId) {
        this.externalAccountOwners.delete(key);
      }
    }
    this.transition(connection.publicConnection, "DISCONNECTED");
    connection.publicConnection.syncState = {
      status: "DISABLED",
      updatedAt: this.clock.now().toISOString(),
    };
    await this.publish("connection.disconnected", connection.publicConnection);
    return clone(connection.publicConnection);
  }

  /** Called by a worker/outbox after authorization; it cannot modify authorization state. */
  public updateSyncState(
    connectionId: string,
    environmentId: string,
    organizationId: string,
    sync: Omit<SyncState, "updatedAt">,
  ): PublicConnection {
    const connection = this.requireScopedConnection(connectionId, environmentId, organizationId);
    if (connection.publicConnection.status !== "CONNECTED") {
      if (connection.publicConnection.status === "DISCONNECTED" && sync.status === "DISABLED") {
        return clone(connection.publicConnection);
      }
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Only connected Amazon integrations can run synchronization.");
    }
    connection.publicConnection.syncState = { ...sync, updatedAt: this.clock.now().toISOString() };
    this.touch(connection.publicConnection);
    return clone(connection.publicConnection);
  }

  public getConnection(connectionId: string, environmentId: string, organizationId: string): PublicConnection {
    return clone(this.requireScopedConnection(connectionId, environmentId, organizationId).publicConnection);
  }

  public getAttempt(attemptId: string, environmentId: string, organizationId: string): ConnectionAttempt {
    const attempt = this.requireAttempt(attemptId).publicAttempt;
    if (attempt.environmentId !== environmentId || attempt.organizationId !== organizationId) {
      throw new AmazonProviderError("AMAZON_CONNECTION_NOT_FOUND", "Amazon connection attempt was not found.");
    }
    return clone(attempt);
  }

  /** Used by an authenticated Chameleon API; never expose without workspace authorization. */
  public getConnectionForEnvironment(connectionId: string, environmentId: string): PublicConnection {
    const connection = this.requireConnection(connectionId);
    if (connection.publicConnection.environmentId !== environmentId) {
      throw new AmazonProviderError("AMAZON_CONNECTION_NOT_FOUND", "Amazon connection was not found.");
    }
    return clone(connection.publicConnection);
  }

  public getAttemptForEnvironment(attemptId: string, environmentId: string): ConnectionAttempt {
    const attempt = this.requireAttempt(attemptId).publicAttempt;
    if (attempt.environmentId !== environmentId) {
      throw new AmazonProviderError("AMAZON_CONNECTION_NOT_FOUND", "Amazon connection attempt was not found.");
    }
    return clone(attempt);
  }

  /** Safe correlation identifier for the UI return URL; it is never a provider credential. */
  public getActiveAttemptId(connectionId: string): string {
    return this.requireConnection(connectionId).activeAttemptId;
  }

  public async disconnectForEnvironment(connectionId: string, environmentId: string): Promise<PublicConnection> {
    const connection = this.getConnectionForEnvironment(connectionId, environmentId);
    return this.disconnect(connectionId, environmentId, connection.organizationId);
  }

  public async reconnectForEnvironment(connectionId: string, environmentId: string): Promise<BeginConnectionResult> {
    const connection = this.getConnectionForEnvironment(connectionId, environmentId);
    return this.reconnect(connectionId, environmentId, connection.organizationId);
  }

  public async selectResourcesForEnvironment(
    connectionId: string,
    environmentId: string,
    resourceIds: readonly string[],
  ): Promise<PublicConnection> {
    const connection = this.getConnectionForEnvironment(connectionId, environmentId);
    return this.selectResources(connectionId, environmentId, connection.organizationId, resourceIds);
  }

  /** Internal only: resolves a pre-validated customer return URL after completion. */
  public getReturnUrl(connectionId: string): string {
    return this.requireConnection(connectionId).returnUrl;
  }

  public getProviderDescriptor() {
    return structuredClone(this.options.provider.descriptor);
  }

  private async refreshConnectionInternal(connectionId: string, environmentId: string, organizationId: string): Promise<void> {
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

  private createAttempt(
    connection: StoredConnection,
    input: { initiatedByUserId: string; intent: ConnectionIntent; expectedProviderAccountId?: string | undefined },
  ): StoredAttempt {
    const now = this.clock.now();
    const attemptId = this.ids.randomId("attempt");
    const browserSessionId = this.ids.randomId("browser");
    const attempt: StoredAttempt = {
      publicAttempt: {
        id: attemptId,
        connectionId: connection.publicConnection.id,
        provider: "amazon",
        environmentId: connection.publicConnection.environmentId,
        organizationId: connection.publicConnection.organizationId,
        initiatedByUserId: input.initiatedByUserId,
        intent: input.intent,
        status: "awaiting_authorization",
        nextAction: "redirect",
        expiresAt: new Date(now.getTime() + BROWSER_SESSION_TTL_MS).toISOString(),
        availableResources: [],
        permissions: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
      browserSessionId,
      initialState: this.ids.randomId("state"),
      loginHandled: false,
      ...(input.expectedProviderAccountId ? { expectedProviderAccountId: input.expectedProviderAccountId } : {}),
    };
    this.attempts.set(attemptId, attempt);
    connection.activeAttemptId = attemptId;
    this.browserSessions.set(browserSessionId, {
      connectionId: connection.publicConnection.id,
      attemptId,
      expiresAt: now.getTime() + BROWSER_SESSION_TTL_MS,
    });
    return attempt;
  }

  private beginResult(connection: StoredConnection, attempt: StoredAttempt): BeginConnectionResult {
    return {
      connection: clone(connection.publicConnection),
      attempt: clone(attempt.publicAttempt),
      authorizationUrl: this.options.provider.getAuthorizationUrl({ state: attempt.initialState }),
      browserSessionId: attempt.browserSessionId,
    };
  }

  private async activateConnection(
    connection: StoredConnection,
    attempt: StoredAttempt,
    credentials: AmazonSellerCredentials,
    stagedScope: CredentialScope,
  ): Promise<void> {
    await this.options.credentialVault.put(connection.publicConnection.id, credentialScope(connection.publicConnection), credentials);
    await this.options.credentialVault.delete(connection.publicConnection.id, stagedScope);
    const sellerId = connection.publicConnection.account?.providerAccountId;
    if (!sellerId) {
      throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Amazon seller identity is unavailable.");
    }
    this.assertExternalAccountAvailable(connection, sellerId);
    this.externalAccountOwners.set(externalAccountKey(connection.publicConnection, sellerId), {
      organizationId: connection.publicConnection.organizationId,
      connectionId: connection.publicConnection.id,
    });
    this.transition(connection.publicConnection, "CONNECTED");
    this.transitionAttempt(attempt, "completed", "complete");
    await this.publish("connection.connected", connection.publicConnection);
  }

  private async failAttempt(
    connection: StoredConnection,
    attempt: StoredAttempt,
    code: string,
    message: string,
  ): Promise<void> {
    this.transitionAttempt(attempt, "failed", "retry", attemptError(code, message, false));
    this.transition(connection.publicConnection, "FAILED");
    await this.publish("connection.failed", connection.publicConnection);
  }

  private assertExternalAccountAvailable(connection: StoredConnection, sellerId: string): void {
    const owner = this.externalAccountOwners.get(externalAccountKey(connection.publicConnection, sellerId));
    if (owner && owner.connectionId !== connection.publicConnection.id) {
      // Do not disclose which workspace owns the seller. A seller must be
      // disconnected before it can be associated with another workspace.
      throw new AmazonProviderError("AMAZON_AUTHORIZATION_DENIED", "This Amazon seller cannot be associated with this workspace.");
    }
  }

  private getActiveBrowserSession(browserSessionId: string): BrowserSession {
    const session = this.browserSessions.get(browserSessionId);
    if (!session || session.expiresAt <= this.clock.now().getTime()) {
      if (session) {
        const attempt = this.attempts.get(session.attemptId);
        if (attempt && attempt.publicAttempt.status === "awaiting_authorization") {
          this.transitionAttempt(attempt, "expired", "retry", attemptError("AMAZON_STATE_EXPIRED", "Authorization has expired.", true));
        }
      }
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

  private requireAttempt(attemptId: string): StoredAttempt {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new AmazonProviderError("AMAZON_CONNECTION_NOT_FOUND", "Amazon connection attempt was not found.");
    }
    return attempt;
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

  private assertActiveAttempt(connection: StoredConnection, attempt: StoredAttempt): void {
    if (connection.activeAttemptId !== attempt.publicAttempt.id) {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Amazon authorization attempt is no longer active.");
    }
  }

  private ensureAttemptStatus(attempt: StoredAttempt, expected: ConnectionAttemptStatus): void {
    if (attempt.publicAttempt.status !== expected) {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Amazon authorization attempt is not in the expected state.");
    }
  }

  private ensureConnectionCanProcess(status: ConnectionStatus): void {
    if (status !== "PENDING" && status !== "REAUTHORIZATION_REQUIRED") {
      throw new AmazonProviderError("AMAZON_CONNECTION_CONFLICT", "Amazon connection is not awaiting authorization.");
    }
  }

  private transition(connection: PublicConnection, status: ConnectionStatus): void {
    connection.status = status;
    connection.authorizationStatus = status;
    this.touch(connection);
  }

  private touch(connection: PublicConnection): void {
    connection.updatedAt = this.clock.now().toISOString();
  }

  private transitionAttempt(
    attempt: StoredAttempt,
    status: ConnectionAttemptStatus,
    nextAction: ConnectionNextAction,
    error?: ConnectionAttempt["error"],
  ): void {
    attempt.publicAttempt.status = status;
    attempt.publicAttempt.nextAction = nextAction;
    attempt.publicAttempt.updatedAt = this.clock.now().toISOString();
    if (error) {
      attempt.publicAttempt.error = error;
    } else {
      delete attempt.publicAttempt.error;
    }
  }

  private async publish(type: ConnectionEvent["type"], connection: PublicConnection): Promise<void> {
    await this.eventSink.publish({
      type,
      connection: clone(connection),
      occurredAt: this.clock.now().toISOString(),
    });
  }
}

function initialSyncState(now: Date): SyncState {
  return { status: "NOT_STARTED", updatedAt: now.toISOString() };
}

function knownAmazonPermissions(): MarketplacePermission[] {
  return [
    {
      id: "amazon.seller.marketplace_participations",
      status: "granted",
      description: "Validated by the Amazon Sellers marketplace participations request.",
    },
    {
      id: "amazon.additional_roles",
      status: "unknown",
      description: "Additional Amazon SP-API roles are not validated by this connection flow.",
    },
  ];
}

function resourcesFromParticipations(
  sellingPartnerId: string,
  participations: MarketplaceParticipationsResponse,
  requireSelection: boolean,
): MarketplaceResource[] {
  return participations.payload
    .filter((entry) => entry.participation.isParticipating)
    .map((entry) => ({
      id: `amazon:${sellingPartnerId}:marketplace:${entry.marketplace.id}`,
      provider: "amazon" as const,
      type: "marketplace" as const,
      providerResourceId: entry.marketplace.id,
      selected: !requireSelection,
      ...(entry.marketplace.name ? { displayName: entry.marketplace.name } : {}),
      ...(entry.marketplace.countryCode ? { region: entry.marketplace.countryCode } : {}),
      metadata: {
        countryCode: entry.marketplace.countryCode,
        domainName: entry.marketplace.domainName,
        defaultCurrencyCode: entry.marketplace.defaultCurrencyCode,
        defaultLanguageCode: entry.marketplace.defaultLanguageCode,
      },
    }));
}

function attemptError(code: string, message: string, retryable: boolean): NonNullable<ConnectionAttempt["error"]> {
  return { code, message, retryable };
}

function requiredRefreshToken(value: string | undefined): string {
  if (!value) {
    throw new AmazonProviderError("AMAZON_TOKEN_EXCHANGE_FAILED", "Amazon did not return a refresh token.");
  }
  return value;
}

function credentialScope(connection: PublicConnection, authorizationAttemptId?: string): CredentialScope {
  return {
    environmentId: connection.environmentId,
    organizationId: connection.organizationId,
    provider: "amazon",
    ...(authorizationAttemptId ? { authorizationAttemptId } : {}),
  };
}

function externalAccountKey(connection: PublicConnection, sellerId: string): string {
  // This service is configured per Amazon SP-API region. A multi-region
  // deployment must include its configured provider region in this key.
  return `${connection.environmentId}:${connection.provider}:${sellerId}`;
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
