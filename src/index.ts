export { createChameleonClient, ChameleonApiError, ChameleonBackendClient } from "./backend.ts";
export { createChameleonFrontendClient, ChameleonFrontendClient } from "./frontend.ts";
export {
  AMAZON_NA_AWS_REGION,
  AMAZON_NA_SP_API_ENDPOINT,
  AMAZON_US_MARKETPLACE_ID,
  AmazonProvider,
  validateAmazonProviderConfig,
} from "./amazon/amazon-provider.ts";
export { AmazonConnectionService, InMemoryConnectionEventSink } from "./amazon/connection-service.ts";
export { AmazonProviderError } from "./amazon/errors.ts";
export { FetchHttpTransport } from "./amazon/http.ts";
export {
  createAmazonHostedApi,
  StaticFrontendSessionAuthenticator,
  StaticSecretKeyAuthenticator,
} from "./amazon/http-api.ts";
export { MarketplaceProviderRegistry } from "./marketplace/registry.ts";
export { documentedMarketplaceAdapters } from "./marketplace/catalog.ts";
export { cryptoIdGenerator, systemClock } from "./amazon/runtime.ts";
export { AesGcmCredentialVault } from "./amazon/vault.ts";
export { signSpApiRequest } from "./amazon/aws-sigv4.ts";
export type {
  AmazonConnectionInput,
  AmazonProviderConfig,
  AmazonSellerCredentials,
  AwsCredentials,
  BeginConnectionResult,
  ConnectionEvent,
  ConnectionEventSink,
  ConnectionStatus,
  Clock,
  CredentialScope,
  CredentialVault,
  HttpRequest,
  HttpResponse,
  HttpTransport,
  LoginCallbackInput,
  IdGenerator,
  PublicConnection,
  PublicMarketplaceAccount,
  RedirectCallbackInput,
} from "./amazon/types.ts";
export type {
  AuthorizationMechanism,
  ConnectionAttempt,
  ConnectionAttemptStatus,
  ConnectionIntent,
  ConnectionNextAction,
  MarketplaceAdapter,
  MarketplaceAuthorizationStatus,
  MarketplacePermission,
  MarketplacePermissionStatus,
  MarketplaceProviderAvailability,
  MarketplaceProviderCapabilities,
  MarketplaceProviderDescriptor,
  MarketplaceProviderId,
  MarketplaceResource,
  MarketplaceResourceType,
  SyncState,
  SyncStatus,
  WorkspaceActor,
  WorkspaceAuthorizationInput,
  WorkspaceAuthorizer,
  WorkspaceConnectionAction,
} from "./marketplace/types.ts";
export type {
  ChameleonBackendClientOptions,
  ConnectSession,
  CreateConnectSessionInput,
} from "./backend.ts";
export type {
  ChameleonFrontendClientOptions,
  CreateFrontendConnectSessionInput,
} from "./frontend.ts";
export type {
  AmazonHostedApiOptions,
  BackendAuthenticationContext,
  BackendSecretKeyAuthenticator,
  FrontendAuthenticationContext,
  FrontendSessionAuthenticator,
} from "./amazon/http-api.ts";
