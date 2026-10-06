# Marketplace connections architecture

## Starting-point assessment

The repository started as an in-memory Amazon vertical slice: `AmazonProvider` handled LWA and SP-API; `AmazonConnectionService` managed connections/callbacks; `AesGcmCredentialVault` protected credentials; and `createAmazonHostedApi` exposed Connect Sessions via Secret Key. There was no Chameleon user authentication, workspace RBAC, independent persistent attempts, resource selection, sync state, queues/workers, or adapters for other marketplaces.

## Clerk principles and Chameleon decisions

From Clerk, Chameleon adopts the separation between a public browser API, a publishable key, an authenticated session, a Secret Key backend API, and a hosted redirect screen. This lets a UI start a connection with a single SDK call, without implementing OAuth in the client product.

What is specific to Chameleon is that the Chameleon user's authorization is not the seller's authorization on the marketplace. The former controls who can connect/disconnect an integration in the workspace; the latter grants access to the external account. A connection also does not determine whether sync is healthy: `authorizationStatus` and `syncState` are independent.

## Implemented domain model

| Concept | Reference implementation | Key rule |
| --- | --- | --- |
| `ConnectionAttempt` | ephemeral state in `AmazonConnectionService` | bound on the server to environment, workspace, initiating user, intent, and allowed destination |
| `MarketplaceConnection` | `PublicConnection` | logical persistent link to the workspace; authorization lifecycle separate from sync |
| `CredentialSet` | AES-256-GCM `CredentialVault` | new credentials stay in the attempt scope before being promoted to the connection |
| `MarketplaceResource` | Amazon resources discovered via marketplace participation | uses the provider's stable identifier, not name/e-mail |
| `SyncState` | `NOT_STARTED`, `QUEUED`, `SYNCING`, `HEALTHY`, `DEGRADED`, `FAILED`, `DISABLED` | workers only update sync and never reclassify a valid authorization as disconnected |

An attempt uses `created`, `awaiting_authorization`, `processing`, `awaiting_selection`, `completed`, `failed`, `cancelled`, or `expired`. The return to the product contains `attempt_id`, `connection_id`, `connection_status`, and no OAuth code, token, or secret.

In this reference, the same Amazon seller can only be linked to one workspace per environment; a second association is rejected without revealing which workspace already owns it. `disconnect` releases that association. In a multi-region implementation, the uniqueness key must include the provider region.

## Trust boundaries

```text
Chameleon UI ── pk_ + Chameleon session ──► Frontend API ─┐
                                                          ├─► validates workspace RBAC
Client backend ── sk_ ─────────────────────► Backend API ─┘        │
                                                                     ▼
                                                          ConnectionAttempt
                                                                     │
Seller Central / provider callback ─────────► Hosted Connect ───────┤
                                                                     ▼
                                                            Credential Vault
                                                                     │
                                                          sync worker/outbox
```

`WorkspaceAuthorizer` is the boundary to Chameleon's real RBAC. The reference implementation keeps the legacy trusted-Secret-Key behavior when it is not configured; in production it must be mandatory. The public route (`/v1/frontend/connect_sessions`) requires both a session authenticator and `WorkspaceAuthorizer`. The browser origin must also be allowed by `isAllowedFrontendOrigin` to enable CORS.

## Current HTTP contracts

| Route | Authentication | Purpose |
| --- | --- | --- |
| `POST /v1/frontend/connect_sessions` | `pk_` + Chameleon session | starts the direct browser UX |
| `GET/POST /v1/frontend/connections/*` and `/v1/frontend/connection_attempts/*` | `pk_` + Chameleon session | reading, selection, reconnect, disconnect, and cancellation in the UI |
| `POST /v1/connect_sessions` | `sk_` | compatibility for trusted backends |
| `GET /v1/marketplaces` | `sk_` | availability and capability catalog per provider |
| `GET /v1/connection_attempts/:id` | `sk_` | reads an attempt without secrets |
| `POST /v1/connection_attempts/:id/cancel` | `sk_` | cancels an open attempt |
| `GET /v1/connections/:id` | `sk_` | reads authorization, resources, permissions, and sync |
| `POST /v1/connections/:id/resources` | `sk_` | selects resources when the provider requires that step |
| `POST /v1/connections/:id/reconnect` | `sk_` | creates a new attempt for the same connection |
| `POST /v1/connections/:id/disconnect` | `sk_` | stops using the credentials and disables sync |

The Amazon callback endpoints remain internal to Chameleon's hosted domain.

## Capability per marketplace

| Marketplace | Status in this repository | Confirmed facts guiding the adapter |
| --- | --- | --- |
| Amazon | **operational (US)** | website/LWA authorization, marketplace discovery, and SigV4; optional marketplace selection |
| eBay | documented, not configured | Application tokens and User tokens are distinct; seller data requires a User token, consent, and RuName/scopes |
| TikTok Shop | documented, not configured | seller access/refresh tokens, granted scopes, and discovery of authorized shops; shop operations use `shop_cipher` when required |
| Temu | documented, not configured | official support for manual and callback authorization; the flow varies by seller type/region |
| Walmart | documented, not configured | OAuth for approved Solution Providers; installation may start from the App Store and uses code/refresh token |

The non-Amazon entries live in `MarketplaceProviderRegistry` with `availability: "not_configured"`. No endpoints, scopes, expiration times, or credential formats are invented for them.

Official sources: [Amazon SP-API](https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow), [eBay authorization](https://developer.ebay.com/develop/guides/sell/authorization), [TikTok Shop entity tags](https://partner.tiktokshop.com/docv2/page/api-entity-tags), [TikTok authorized shops](https://partner.tiktokshop.com/docv2/page/get-authorized-shops), [Temu Seller Authorization Guide](https://partner.temu.com/documentation?menu_code=38e79b35d2cb463d85619c1c786dd303), and [Walmart OAuth authorization](https://developer.walmart.com/us-marketplace/docs/oauth-20-authorization).

## Production migration

This delivery does not add a database, queue, or Chameleon identity because the repository did not have those services. The migration must create tables/collections equivalent to `connection_attempts`, `marketplace_connections`, `authorization_grants`, `marketplace_resources`, `sync_states`, and an event outbox. Unique indexes must cover provider, environment, region when applicable, and external ID. Credentials must go to KMS/envelope encryption, not the in-memory vault.

When migrating, load the existing Amazon state as a connection with `syncState: NOT_STARTED`, create an attempt only for new flows, and do not migrate tokens into public responses. Use a distributed lock per grant during refresh and a transaction/outbox for credential promotion, connection activation, and enqueuing the first sync.

## Deliberate limitations

- The implementation is an in-memory reference: it provides no durability, distributed lock, worker, queue, webhook, or remote Amazon revocation.
- The Amazon integration is US-only and depends on an approved SP-API application, registered HTTPS callbacks, roles, and a test seller for real validation.
- The other adapters require onboarding, credentials, an environment/sandbox, and per-provider contract tests before being enabled.
- `@chameleon/react` is not yet a separate package. The browser-safe `createChameleonFrontendClient` was included in the reference package and can serve as the basis for that public package.
