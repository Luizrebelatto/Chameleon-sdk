/**
 * Provider identifiers are public API values. Provider-specific credentials,
 * callback parameters, and request signing never belong in this module.
 */
export type MarketplaceProviderId = "amazon" | "ebay" | "tiktok_shop" | "temu" | "walmart";

export type ConnectionIntent = "CONNECT" | "RECONNECT" | "EXPAND_PERMISSIONS";

export type ConnectionAttemptStatus =
  | "created"
  | "awaiting_authorization"
  | "processing"
  | "awaiting_selection"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

/** The persistent authorization lifecycle. It is deliberately distinct from syncState. */
export type MarketplaceAuthorizationStatus =
  | "PENDING"
  | "CONNECTED"
  | "REAUTHORIZATION_REQUIRED"
  | "DISCONNECTED"
  | "FAILED";

export type SyncStatus = "NOT_STARTED" | "QUEUED" | "SYNCING" | "HEALTHY" | "DEGRADED" | "FAILED" | "DISABLED";

export interface SyncState {
  status: SyncStatus;
  updatedAt: string;
  lastSuccessfulSyncAt?: string | undefined;
  lastFailure?: { code: string; message: string; retryable: boolean } | undefined;
}

export type MarketplaceResourceType = "account" | "store" | "marketplace";

/**
 * A stable, public representation of an account, shop, or marketplace that a
 * seller authorization makes accessible. `providerResourceId`, not a name or
 * e-mail address, is the identity used for binding.
 */
export interface MarketplaceResource {
  id: string;
  provider: MarketplaceProviderId;
  type: MarketplaceResourceType;
  providerResourceId: string;
  selected: boolean;
  displayName?: string | undefined;
  region?: string | undefined;
  metadata: Record<string, unknown>;
}

export type MarketplacePermissionStatus = "granted" | "missing" | "unknown";

export interface MarketplacePermission {
  id: string;
  status: MarketplacePermissionStatus;
  description?: string | undefined;
}

export type ConnectionNextAction = "redirect" | "select_resources" | "reauthorize" | "retry" | "complete" | "none";

/** Public, credential-free state for a recoverable connection journey. */
export interface ConnectionAttempt {
  id: string;
  connectionId: string;
  provider: MarketplaceProviderId;
  environmentId: string;
  organizationId: string;
  initiatedByUserId: string;
  intent: ConnectionIntent;
  status: ConnectionAttemptStatus;
  nextAction: ConnectionNextAction;
  expiresAt: string;
  availableResources: MarketplaceResource[];
  permissions: MarketplacePermission[];
  error?: { code: string; message: string; retryable: boolean } | undefined;
  createdAt: string;
  updatedAt: string;
}

export type AuthorizationMechanism = "oauth" | "app_store_callback" | "manual_credential" | "unsupported";

/**
 * Capabilities describe the provider rather than pretending all providers are
 * OAuth implementations. An adapter may support more than one mechanism.
 */
export interface MarketplaceProviderCapabilities {
  authorization: readonly AuthorizationMechanism[];
  supportsPkce: boolean;
  supportsRefresh: boolean;
  supportsRemoteRevocation: boolean;
  supportsResourceSelection: boolean;
  supportsAppStoreInitiatedInstall: boolean;
  requiresAdditionalResourceIdentifier: boolean;
}

export type MarketplaceProviderAvailability = "enabled" | "not_configured" | "research_required";

export interface MarketplaceProviderDescriptor {
  id: MarketplaceProviderId;
  availability: MarketplaceProviderAvailability;
  capabilities: MarketplaceProviderCapabilities;
  documentationUrl?: string | undefined;
}

/**
 * Contract used by the internal orchestrator. Operations are optional by
 * capability so that, for example, a manual Temu credential flow is never
 * forced through an OAuth-only shape.
 */
export interface MarketplaceAdapter {
  readonly descriptor: MarketplaceProviderDescriptor;
  startAuthorization?: (input: unknown) => Promise<unknown>;
  processAuthorizationCallback?: (input: unknown) => Promise<unknown>;
  discoverResources?: (input: unknown) => Promise<MarketplaceResource[]>;
  refreshAccess?: (input: unknown) => Promise<void>;
  revokeAccess?: (input: unknown) => Promise<void>;
  prepareAuthenticatedRequest?: (input: unknown) => Promise<unknown>;
}

export interface WorkspaceActor {
  userId: string;
}

export type WorkspaceConnectionAction =
  | "connection:create"
  | "connection:read"
  | "connection:cancel_attempt"
  | "connection:select_resources"
  | "connection:reconnect"
  | "connection:disconnect";

export interface WorkspaceAuthorizationInput {
  environmentId: string;
  organizationId: string;
  actor: WorkspaceActor;
  action: WorkspaceConnectionAction;
}

/** Integrate this boundary with the Chameleon user/session and workspace RBAC systems. */
export interface WorkspaceAuthorizer {
  assertAuthorized(input: WorkspaceAuthorizationInput): Promise<void>;
}
