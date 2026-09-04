import type {
  ConnectionAttempt,
  ConnectionIntent,
  MarketplaceAuthorizationStatus,
  MarketplacePermission,
  MarketplaceResource,
  SyncState,
} from "../marketplace/types.ts";

export type AmazonApplicationVersion = "draft" | "production";

/** @deprecated Use MarketplaceAuthorizationStatus in new shared code. */
export type ConnectionStatus = MarketplaceAuthorizationStatus;

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AmazonProviderConfig {
  applicationId: string;
  lwaClientId: string;
  lwaClientSecret: string;
  awsCredentials: AwsCredentials;
  redirectUri: string;
  loginUri: string;
  applicationVersion: AmazonApplicationVersion;
  sellerCentralBaseUrl?: string;
  spApiBaseUrl?: string;
  awsRegion?: string;
  userAgent: string;
}

export interface AmazonConnectionInput {
  environmentId: string;
  organizationId: string;
  returnUrl: string;
  /** Bound by the Chameleon server from an authenticated user/session, never a callback parameter. */
  initiatedByUserId?: string | undefined;
  intent?: ConnectionIntent | undefined;
}

export interface PublicMarketplaceAccount {
  id: string;
  provider: "amazon";
  providerAccountId: string;
  displayName?: string;
  country?: string;
  marketplaceIds: string[];
  metadata: Record<string, unknown>;
}

export interface PublicConnection {
  id: string;
  environmentId: string;
  organizationId: string;
  provider: "amazon";
  status: ConnectionStatus;
  /** Mirrors the authorization lifecycle; sync failures never change this field. */
  authorizationStatus: ConnectionStatus;
  syncState: SyncState;
  account?: PublicMarketplaceAccount;
  resources: MarketplaceResource[];
  permissions: MarketplacePermission[];
  createdAt: string;
  updatedAt: string;
}

export interface BeginConnectionResult {
  connection: PublicConnection;
  attempt: ConnectionAttempt;
  authorizationUrl: string;
  /**
   * Short-lived Connect Session capability. The customer backend may pass this
   * to its frontend only to open Hosted Connect. The Chameleon HTTP layer must
   * immediately exchange it for a Secure, HttpOnly, SameSite=Lax cookie before
   * redirecting to Amazon; do not persist it in browser storage.
   */
  browserSessionId: string;
}

export interface LoginCallbackInput {
  browserSessionId: string;
  amazonCallbackUri: string;
  amazonState: string;
  sellingPartnerId: string;
  version?: string | undefined;
}

export interface RedirectCallbackInput {
  state: string;
  sellingPartnerId: string;
  spapiOauthCode: string;
}

export interface LwaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

export interface AmazonSellerCredentials {
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: string;
}

export interface MarketplaceParticipation {
  marketplace: {
    id: string;
    countryCode?: string;
    defaultCurrencyCode?: string;
    defaultLanguageCode?: string;
    domainName?: string;
    name?: string;
  };
  participation: {
    isParticipating: boolean;
    hasSuspendedListings?: boolean;
  };
}

export interface MarketplaceParticipationsResponse {
  payload: MarketplaceParticipation[];
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  randomId(prefix: string): string;
}

export interface CredentialVault {
  put(connectionId: string, scope: CredentialScope, credentials: AmazonSellerCredentials): Promise<void>;
  get(connectionId: string, scope: CredentialScope): Promise<AmazonSellerCredentials | undefined>;
  delete(connectionId: string, scope: CredentialScope): Promise<void>;
}

export interface CredentialScope {
  environmentId: string;
  organizationId: string;
  provider: "amazon";
  /** A temporary, encrypted credential set for a reconnect attempt. */
  authorizationAttemptId?: string | undefined;
}

export interface ConnectionEvent {
  type:
    | "connection.pending"
    | "connection.connected"
    | "connection.reauthorization_required"
    | "connection.disconnected"
    | "connection.failed";
  connection: PublicConnection;
  occurredAt: string;
}

export interface ConnectionEventSink {
  publish(event: ConnectionEvent): Promise<void>;
}
