# Backlog — Chameleon Marketplace Connections

## Product vision

Chameleon will be a marketplace connections platform distributed through SDKs, following the same Developer Experience principle as Clerk:

- the customer installs a small, typed library;
- the library talks to APIs hosted by Chameleon;
- Chameleon controls OAuth, callbacks, credentials, refresh, security, and integrations;
- the customer uses a **Publishable Key** on the frontend and a **Secret Key** on the backend;
- development and production environments are isolated;
- ready-made components coexist with APIs for custom flows.

This does not mean copying Clerk's user authentication. Chameleon's core resource is `MarketplaceConnection`, not `User` or `Session`.

Conceptual references:

- [Clerk API overview](https://clerk.com/docs/reference/api/overview)
- [Clerk backend client](https://clerk.com/docs/reference/backend/overview)
- [Clerk SDK types](https://clerk.com/docs/guides/development/sdk-development/types)

## Target architecture

```text
                         CUSTOMER APPLICATION
                  ┌──────────────┴──────────────┐
                  │                             │
          @chameleon/react              @chameleon/backend
           Publishable Key                 Secret Key
                  │                             │
                  ▼                             ▼
        Chameleon Frontend API       Chameleon Backend API
                  │                             │
                  └──────────────┬──────────────┘
                                 ▼
                      Connection Orchestrator
                                 │
             ┌───────────────────┼───────────────────┐
             │                   │                   │
        OAuth State        Credential Vault     Event/Webhooks
             │                   │                   │
             └───────────────────┼───────────────────┘
                                 ▼
                       Internal Provider Layer
              Etsy / eBay / Walmart / TikTok / Amazon / Temu
```

## Responsibility boundaries

### Chameleon hosts and controls

- Backend API and Frontend API.
- Hosted Connect UI and OAuth callbacks.
- Registration of applications, environments, and keys.
- Provider app credentials and seller tokens.
- Connections/accounts database and credential vault.
- Token refresh, retries, rate limits, locks, and auditing.
- State-change webhooks for customers.
- Configuration and observability dashboard.

### The customer controls

- Their own application's users and organizations.
- The backend call that creates a Connect Session.
- When and in which UI the connection is started.
- The mapping between their external IDs and Chameleon resources.
- Handling of received webhooks/events.
- Secret Key only on the backend and Publishable Key on the frontend.

### Out of the MVP

- Local/standalone execution of marketplace adapters in the customer's application.
- Handing refresh tokens or client secrets to the customer.
- Orders, products, inventory, fulfillment, and finance.
- Native mobile SDKs.
- Customer-provided marketplace app credentials (BYOC), unless a provider requires it.

## Resource model

```text
Application
└── Environment (test | live)
    ├── Publishable Key
    ├── Secret Keys
    ├── Allowed Origins / Redirect URLs
    ├── Webhook Endpoints
    └── Organization (externalId)
        └── MarketplaceConnection
            ├── MarketplaceAccount
            └── CredentialEnvelope (internal and inaccessible to the customer)
```

## Desired Developer Experience

### Backend

```typescript
import { createChameleonClient } from "@chameleon/backend";

const chameleon = createChameleonClient({
  secretKey: process.env.CHAMELEON_SECRET_KEY!,
});

const session = await chameleon.connectSessions.create({
  organizationId: "org_123",
  provider: "amazon",
  returnUrl: "https://app.example.com/integrations",
});
```

### Frontend

```tsx
<ChameleonProvider publishableKey={process.env.NEXT_PUBLIC_CHAMELEON_PUBLISHABLE_KEY!}>
  <ConnectMarketplaceButton connectSessionToken={token} />
</ChameleonProvider>
```

### Public result

```json
{
  "id": "conn_123",
  "provider": "amazon",
  "status": "CONNECTED",
  "account": {
    "id": "acct_123",
    "providerAccountId": "seller_123",
    "displayName": "Example Seller",
    "country": "US",
    "marketplaceIds": ["marketplace_us"]
  }
}
```

No public API or SDK returns an access token, refresh token, authorization code, or marketplace application credential.

## Milestones

1. **v0.1 — Platform Foundation:** applications, environments, keys, APIs, and hosted callback.
2. **v0.2 — Etsy Connect:** first end-to-end provider via the Backend SDK.
3. **v0.3 — Hosted Connect:** hosted UI and minimal frontend SDK.
4. **v0.4 — eBay:** validation of the multi-provider abstraction.
5. **v0.5 — Walmart Marketplace US.**
6. **v0.6 — Reliability and production.**
7. **v0.7 — TikTok Shop US.**
8. **v0.8 — Amazon US SP-API.**
9. **v0.9 — Temu US**, subject to the official API and approval.
10. **Future:** advanced React, marketplace webhooks, and Universal Marketplace API.

## Conventions

- Status: `[ ]` pending, `[-]` externally blocked, `[x]` done.
- Priority: `P0` blocks the milestone; `P1` is required for the release; `P2` is later.
- Size: `S` up to 1 day; `M` 1 to 3 days; `L` needs refinement.
- Real tests are opt-in and never run in the default CI.
- Every mutating API supports idempotency when there is a risk of repetition.

---

## Epic 0 — Architecture and contracts

### [ ] CHM-001 — Record the hosted-first architecture

**Priority/Size:** P0 / M  
**Dependencies:** none

**Deliverable:** ADR defining the Frontend API, Backend API, Hosted Connect, SDKs, and internal provider runtime.

**Acceptance criteria:**

- States that the public SDK does not access marketplace APIs directly.
- OAuth callbacks and seller credentials belong to the platform.
- Defines each component's boundaries and the communication between them.
- Explicitly separates control plane, connection orchestration, and provider layer.

### [ ] CHM-002 — Model tenancy and environment isolation

**Priority/Size:** P0 / M  
**Dependencies:** CHM-001

**Deliverable:** `Application → Environment → Organization → Connection` model.

**Acceptance criteria:**

- Test and live do not share keys, data, webhooks, or credentials.
- Customer external IDs are scoped per environment.
- Every internal query requires `environmentId`.
- An organization supports multiple accounts per provider.

### [ ] CHM-003 — Define resources and public API v1

**Priority/Size:** P0 / L  
**Dependencies:** CHM-002

**Deliverable:** initial OpenAPI for applications, organizations, connect sessions, connections, and webhook endpoints.

**Acceptance criteria:**

- Public routes do not expose credential resources.
- Pagination, filters, errors, and idempotency keys have a consistent format.
- All objects have opaque IDs, timestamps, and environment.
- The contract allows generating the Backend SDK types.

### [ ] CHM-004 — Define the Frontend API and Connect Session

**Priority/Size:** P0 / M  
**Dependencies:** CHM-003

**Deliverable:** contract for the ephemeral token that authorizes a single connection journey.

**Acceptance criteria:**

- A Publishable Key alone does not create a connection for an arbitrary organization.
- The token is short-lived, bound to provider/organization/return URL, and single-use when applicable.
- The Frontend API does not accept a Secret Key.
- Claims and server-side validation are documented.

### [ ] CHM-005 — Create the platform threat model

**Priority/Size:** P0 / L  
**Dependencies:** CHM-001 to CHM-004

**Deliverable:** threat model for keys, OAuth, callbacks, token vault, tenants, webhooks, dashboard, and supply chain.

**Acceptance criteria:**

- Covers replay, CSRF, SSRF, open redirect, callback injection, and confused deputy.
- Defines rotation, redaction, TTL, auditing, and least privilege.
- Each required mitigation has an associated ticket.

---

## Epic 1 — Repository and foundation

### [ ] CHM-010 — Initialize the TypeScript monorepo

**Priority/Size:** P0 / M  
**Dependencies:** CHM-001

**Deliverable:** workspace with separate apps and packages.

**Initial structure:**

```text
apps/
  api/
  connect/
  dashboard/
packages/
  backend/
  react/
  api-types/
  provider-core/
  providers/
  config/
```

**Acceptance criteria:**

- Internal packages do not leak into the public SDK exports.
- Build, lint, typecheck, and tests work from the root.
- Minimum Node.js and TypeScript versions are declared.

### [ ] CHM-011 — Configure tests and quality gates

**Priority/Size:** P0 / M  
**Dependencies:** CHM-010

**Deliverable:** unit, integration, and contract test layers.

**Acceptance criteria:**

- CI runs clean install, lint, typecheck, tests, and build.
- Provider tests do not access the network by default.
- Coverage ignores generated code and artifacts.

### [ ] CHM-012 — Configure secrets and environment management

**Priority/Size:** P0 / M  
**Dependencies:** CHM-005, CHM-010

**Deliverable:** validated configuration for local, test, staging, and production.

**Acceptance criteria:**

- Secrets are not committed or included in images/artifacts.
- Production uses a compatible secret manager/KMS.
- Startup fails early without printing sensitive values.

### [ ] CHM-013 — Configure migrations and the database

**Priority/Size:** P0 / M  
**Dependencies:** CHM-010

**Deliverable:** PostgreSQL, migration tooling, and transactional strategy.

**Acceptance criteria:**

- Migrations have documented rollback/forward-fix.
- Tests use an isolated, disposable database.
- No ORM model is exposed in the SDKs.

### [ ] CHM-014 — Generate types/clients from OpenAPI

**Priority/Size:** P1 / M  
**Dependencies:** CHM-003, CHM-010

**Deliverable:** generation pipeline with breaking-change validation.

**Acceptance criteria:**

- Artifacts are deterministic.
- CI detects an outdated contract.
- Generated code is wrapped by ergonomic SDK APIs.

---

## Epic 2 — Applications, environments, and API keys

### [ ] CHM-020 — Persist Application and Environment

**Priority/Size:** P0 / M  
**Dependencies:** CHM-002, CHM-013

**Deliverable:** schema and repositories for applications and test/live environments.

**Acceptance criteria:**

- Each environment has a stable slug/ID and isolated configuration.
- Production does not query test data.
- Deletion respects retention and dependent resources.

### [ ] CHM-021 — Issue Publishable Keys

**Priority/Size:** P0 / M  
**Dependencies:** CHM-020

**Deliverable:** keys with recognizable test/live prefixes and minimal public metadata.

**Acceptance criteria:**

- A Publishable Key identifies the environment but does not grant administrative access.
- Rotation/revocation is supported.
- The key can be exposed on the frontend without revealing a secret.

### [ ] CHM-022 — Issue and store Secret Keys

**Priority/Size:** P0 / M  
**Dependencies:** CHM-020, CHM-005

**Deliverable:** test/live Secret Keys displayed once and stored with appropriate protection.

**Acceptance criteria:**

- Prefixes distinguish test/live.
- The full value cannot be retrieved after creation.
- Supports multiple keys, name, last-used, rotation, and revocation.
- Logs and traces never include the key.

### [ ] CHM-023 — Authenticate the Backend API by Secret Key

**Priority/Size:** P0 / M  
**Dependencies:** CHM-022

**Deliverable:** middleware that resolves application/environment and enforces authorization.

**Acceptance criteria:**

- An invalid/revoked key returns a consistent error.
- Every request gets a request ID and environment context.
- Comparison and lookup do not leak timing/undue metadata.

### [ ] CHM-024 — Resolve the Frontend API by Publishable Key

**Priority/Size:** P0 / M  
**Dependencies:** CHM-021

**Deliverable:** public middleware with strict per-endpoint policies.

**Acceptance criteria:**

- Does not grant access to the Backend API.
- Validates allowed origins when applicable.
- Returns only safe frontend configuration.

### [ ] CHM-025 — Manage allowed origins and redirect URLs

**Priority/Size:** P0 / M  
**Dependencies:** CHM-020, CHM-005

**Deliverable:** registration and exact validation of origins/URLs per environment.

**Acceptance criteria:**

- Blocks unsafe wildcards and open redirects.
- URL normalization has bypass tests.
- Localhost is allowed only by the development policy.

### [ ] CHM-026 — Apply rate limits to public APIs

**Priority/Size:** P1 / M  
**Dependencies:** CHM-023, CHM-024

**Deliverable:** limits per environment, key, IP, and route when appropriate.

**Acceptance criteria:**

- Responses provide safe retry hints.
- Limits do not allow inferring the existence of another tenant.
- Configuration supports future plans without coupling them to the SDK.

---

## Epic 3 — Domain, persistence, and credential vault

### [ ] CHM-030 — Model Organization, Connection, and Account

**Priority/Size:** P0 / M  
**Dependencies:** CHM-002, CHM-013

**Deliverable:** normalized entities and multi-tenant constraints.

**Acceptance criteria:**

- Organization accepts a customer-provided `externalId`.
- An organization can own multiple accounts from the same provider.
- The provider account ID is distinct from the Chameleon ID.
- Tokens do not appear in public entities.

### [ ] CHM-031 — Implement the connection state machine

**Priority/Size:** P0 / M  
**Dependencies:** CHM-030

**Deliverable:** transitions between `PENDING`, `CONNECTED`, `REAUTHORIZATION_REQUIRED`, `DISCONNECTED`, and `FAILED`.

**Acceptance criteria:**

- Invalid transitions are rejected.
- History records the safe cause, actor, and timestamp.
- A partial failure does not produce `CONNECTED` without a valid account/credentials.

### [ ] CHM-032 — Create the credential vault

**Priority/Size:** P0 / L  
**Dependencies:** CHM-005, CHM-013, CHM-030

**Deliverable:** encrypted storage of provider app credentials and seller credentials.

**Acceptance criteria:**

- Uses envelope encryption with KMS and key version.
- Associated data includes environment, connection, and provider.
- Only authorized workers/services can decrypt.
- Database, logs, traces, and backups contain no plaintext.

### [ ] CHM-033 — Implement vault rotation and auditing

**Priority/Size:** P1 / L  
**Dependencies:** CHM-032

**Deliverable:** re-encryption, key rotation, and access audit trail.

**Acceptance criteria:**

- Rotation does not require disconnecting sellers.
- Plaintext access produces an audit event without the value.
- Failures can be resumed safely.

### [ ] CHM-034 — Persist OAuth transactions

**Priority/Size:** P0 / M  
**Dependencies:** CHM-030

**Deliverable:** server-side state, PKCE, nonce, redirect, provider, and TTL.

**Acceptance criteria:**

- State is CSPRNG, single-use, and consumed atomically.
- The transaction belongs to an environment, organization, and connection.
- Expired data is removed by a retention job.

### [ ] CHM-035 — Implement Backend API idempotency

**Priority/Size:** P0 / M  
**Dependencies:** CHM-013, CHM-023

**Deliverable:** idempotency key support for creation, disconnect, and critical mutating operations.

**Acceptance criteria:**

- A repetition returns the same logical result.
- The key is scoped per environment and operation.
- A conflicting payload with the same key is rejected.

### [ ] CHM-036 — Implement a distributed lock per connection

**Priority/Size:** P1 / M  
**Dependencies:** CHM-030

**Deliverable:** mutual exclusion for concurrent refresh, callback, and reconnect.

**Acceptance criteria:**

- The lock has a timeout and fencing/a strategy against dead owners.
- Tests prove that only one effective refresh occurs.
- A lock failure does not corrupt credentials.

### [ ] CHM-037 — Implement retention and deletion

**Priority/Size:** P1 / M  
**Dependencies:** CHM-030 to CHM-034

**Deliverable:** policies for OAuth transactions, credentials, accounts, logs, and backups.

**Acceptance criteria:**

- Disconnect and deletion have documented semantics.
- Temporary sensitive data has a minimal TTL.
- Jobs are idempotent and auditable.

---

## Epic 4 — Internal provider runtime

### [ ] CHM-040 — Define the central provider catalog

**Priority/Size:** P0 / S  
**Dependencies:** CHM-010

**Deliverable:** IDs `etsy`, `ebay`, `walmart`, `tiktok_shop`, `amazon`, and `temu`, with status per environment.

**Acceptance criteria:**

- An unimplemented provider never appears as available.
- The catalog is not duplicated across API, dashboard, and SDKs.
- Public display metadata does not include sensitive configuration.

### [ ] CHM-041 — Define the internal `MarketplaceProvider` contract

**Priority/Size:** P0 / M  
**Dependencies:** CHM-030, CHM-034, CHM-040

**Deliverable:** contract for authorization, exchange, refresh, account, validation, revocation, and capabilities.

**Acceptance criteria:**

- Inputs use safe references to credentials, not public secrets.
- Provider-specific metadata does not contaminate the generic domain.
- Optional operations are capabilities, not branches in the orchestrator.

### [ ] CHM-042 — Implement the Provider Registry

**Priority/Size:** P0 / S  
**Dependencies:** CHM-041

**Deliverable:** provider registration, lookup, and health/availability.

**Acceptance criteria:**

- Prevents duplicate IDs.
- An unavailable provider returns an actionable public error.
- Adding a provider does not require editing the Connection Orchestrator.

### [ ] CHM-043 — Create the HTTP runtime for providers

**Priority/Size:** P0 / M  
**Dependencies:** CHM-005, CHM-041

**Deliverable:** internal HTTP client with timeout, abort, retry hooks, and redaction.

**Acceptance criteria:**

- Responses have a maximum size and safe parsing.
- Authorization headers and sensitive bodies are never logged.
- Tests use a fake transport without network.

### [ ] CHM-044 — Create a normalized error hierarchy

**Priority/Size:** P0 / M  
**Dependencies:** CHM-041

**Deliverable:** internal and public errors for OAuth, credentials, permissions, throttling, provider, and storage.

**Acceptance criteria:**

- The public error contains code, provider, retryable, and request ID.
- Sensitive cause stays only in restricted, redacted observability.
- The SDK maps the same shape to typed classes.

### [ ] CHM-045 — Create the provider contract test suite

**Priority/Size:** P0 / M  
**Dependencies:** CHM-041 to CHM-044

**Deliverable:** reusable tests for authorization, callback, refresh, account, errors, and capabilities.

**Acceptance criteria:**

- Every delivered provider must pass the suite.
- Unsupported cases are declared by capability.
- No default test accesses the internet.

---

## Epic 5 — Hosted Connection Orchestrator

### [ ] CHM-050 — Create a Connect Session via the Backend API

**Priority/Size:** P0 / L  
**Dependencies:** CHM-004, CHM-023, CHM-030, CHM-035

**Deliverable:** authenticated endpoint that creates the organization when needed, a pending connection, and an ephemeral frontend token.

**Acceptance criteria:**

- Accepts an external organization ID, provider, and allowed return URL.
- Returns `connectSessionToken`, `connectUrl`, expiration, and connection ID.
- The idempotency key prevents duplicate sessions/connections.
- The Secret Key is never propagated to the frontend.

### [ ] CHM-051 — Start authorization via Hosted Connect

**Priority/Size:** P0 / M  
**Dependencies:** CHM-024, CHM-034, CHM-042, CHM-050

**Deliverable:** the Frontend API validates the Connect Session, creates an OAuth transaction, and redirects to the provider.

**Acceptance criteria:**

- Provider and connection cannot be swapped by the browser.
- Generates state/PKCE according to capabilities.
- Only registered redirect URLs are accepted.

### [ ] CHM-052 — Host the OAuth callback per provider

**Priority/Size:** P0 / L  
**Dependencies:** CHM-034, CHM-041, CHM-051

**Deliverable:** callback on a Chameleon domain that validates state and performs the code exchange.

**Acceptance criteria:**

- State is consumed atomically before finalizing.
- A duplicate callback is idempotent.
- Denial, invalid state, and provider errors produce consistent states.
- The authorization code is never sent to the customer's application.

### [ ] CHM-053 — Finalize account and connection

**Priority/Size:** P0 / L  
**Dependencies:** CHM-032, CHM-052

**Deliverable:** encrypts credentials, retrieves identity, and persists account/connection transactionally.

**Acceptance criteria:**

- A connection only becomes `CONNECTED` with valid credentials and account.
- The same provider account in the same organization is not silently duplicated.
- The completion event is produced after commit.

### [ ] CHM-054 — Get and list connections

**Priority/Size:** P0 / M  
**Dependencies:** CHM-023, CHM-030

**Deliverable:** Backend API for get/list with filters and pagination.

**Acceptance criteria:**

- Isolation per environment is mandatory.
- Returns the normalized account and status, never credentials.
- SDK types represent all possible states.

### [ ] CHM-055 — Implement disconnect and reconnect

**Priority/Size:** P0 / L  
**Dependencies:** CHM-031, CHM-035, CHM-053

**Deliverable:** idempotent endpoints and the corresponding Hosted Connect journeys.

**Acceptance criteria:**

- Reconnect generates a new transaction/state.
- Revokes at the provider when supported.
- Disconnect blocks refresh and future executions.
- Events are produced after the transition is persisted.

### [ ] CHM-056 — Implement the refresh worker

**Priority/Size:** P1 / L  
**Dependencies:** CHM-032, CHM-036, CHM-041

**Deliverable:** proactive/on-demand refresh with queue and lock.

**Acceptance criteria:**

- Refresh token rotation is persisted atomically.
- A definitive failure marks `REAUTHORIZATION_REQUIRED`.
- Backoff, jitter, and dead-letter policy are documented.

---

## Epic 6 — Backend API and `@chameleon/backend`

### [ ] CHM-060 — Implement Backend API v1

**Priority/Size:** P0 / L  
**Dependencies:** CHM-023, CHM-050, CHM-054, CHM-055

**Deliverable:** versioned routes for organizations, connect sessions, and connections.

**Acceptance criteria:**

- The implementation matches the OpenAPI.
- Errors have a stable shape and request ID.
- CORS does not enable browser access with a Secret Key.

### [ ] CHM-061 — Create `createChameleonClient()`

**Priority/Size:** P0 / M  
**Dependencies:** CHM-014, CHM-060

**Deliverable:** server-side client authenticated by Secret Key.

**Acceptance criteria:**

- The API base can be overridden only for test/self-hosted development.
- The Secret Key is validated without appearing in errors.
- The client supports timeout, AbortSignal, user agent, and request ID.

### [ ] CHM-062 — Implement Backend SDK resources

**Priority/Size:** P0 / L  
**Dependencies:** CHM-061

**Deliverable:** `organizations`, `connectSessions`, and `connections` with typed methods.

**Acceptance criteria:**

- Methods mirror resources, not raw endpoints.
- Pagination and errors are ergonomic.
- No method accepts/returns a marketplace token.

### [ ] CHM-063 — Implement retry and idempotency in the SDK

**Priority/Size:** P1 / M  
**Dependencies:** CHM-061, CHM-062

**Deliverable:** safe retries, idempotency keys, and SDK telemetry.

**Acceptance criteria:**

- Does not repeat an unsafe operation without an idempotency key.
- Honors Retry-After and AbortSignal.
- Telemetry contains no Secret Key or sensitive data.

### [ ] CHM-064 — Publish a Backend SDK prerelease

**Priority/Size:** P0 / M  
**Dependencies:** CHM-061 to CHM-063

**Deliverable:** npm package with JS, declarations, source maps, README, and changelog.

**Acceptance criteria:**

- The tarball installs in an external smoke-test project.
- Exports work in the supported module formats.
- The package contains no internal provider code or secrets.

---

## Epic 7 — Etsy Connect (first provider)

### [ ] CHM-070 — Validate official Etsy requirements

**Priority/Size:** P0 / S  
**Dependencies:** CHM-041

**Deliverable:** current endpoints, scopes, PKCE, refresh, identity, and revocation documented with links/dates.

### [ ] CHM-071 — Configure Etsy in the credential vault

**Priority/Size:** P0 / M  
**Dependencies:** CHM-032, CHM-070

**Deliverable:** provider app config per environment, accessible only to the internal runtime.

### [ ] CHM-072 — Implement Etsy authorization with PKCE

**Priority/Size:** P0 / M  
**Dependencies:** CHM-034, CHM-071

**Deliverable:** authorization URL and server-side transaction.

### [ ] CHM-073 — Implement Etsy exchange and persistence

**Priority/Size:** P0 / M  
**Dependencies:** CHM-052, CHM-071, CHM-072

**Deliverable:** code exchange, credential normalization, and vault.

### [ ] CHM-074 — Retrieve and normalize the Etsy shop

**Priority/Size:** P0 / M  
**Dependencies:** CHM-073

**Deliverable:** seller/shop identity mapped to `MarketplaceAccount`.

### [ ] CHM-075 — Implement Etsy refresh, revocation, and errors

**Priority/Size:** P0 / L  
**Dependencies:** CHM-073

**Deliverable:** complete lifecycle and error mapper.

### [ ] CHM-076 — Test Etsy end to end

**Priority/Size:** P0 / L  
**Dependencies:** CHM-045, CHM-050 to CHM-056, CHM-072 to CHM-075

**Deliverable:** contract/unit/integration tests from the Backend SDK down to a mocked provider.

### [-] CHM-077 — Validate real Etsy

**Priority/Size:** P0 / S  
**Dependencies:** CHM-076  
**Expected blocker:** Etsy test application and shop

**Deliverable:** real Hosted Connect connects a shop and the Backend SDK queries the connection without exposing tokens.

---

## Epic 8 — Hosted Connect and frontend SDK

### [ ] CHM-080 — Create the Hosted Connect application

**Priority/Size:** P0 / L  
**Dependencies:** CHM-024, CHM-050, CHM-051

**Deliverable:** hosted page that presents the provider, consent, loading, success, and error.

**Acceptance criteria:**

- The Connect Session token is validated server-side.
- Does not process the Secret Key or marketplace credentials in the browser.
- The return URL is previously allowed and does not come freely from the query string.

### [ ] CHM-081 — Create `@chameleon/connect-js`

**Priority/Size:** P0 / M  
**Dependencies:** CHM-004, CHM-024, CHM-080

**Deliverable:** minimal frontend client to open Hosted Connect and receive the result.

**Acceptance criteria:**

- Initializes with a Publishable Key and Connect Session Token.
- `opened`, `connected`, `exited`, and `error` events have a safe payload.
- Contains no Secret Key or provider logic.

### [ ] CHM-082 — Validate origins, popup, and postMessage

**Priority/Size:** P0 / L  
**Dependencies:** CHM-025, CHM-080, CHM-081

**Deliverable:** secure iframe/popup/parent communication.

**Acceptance criteria:**

- `targetOrigin` never uses a wildcard in production.
- Messages have nonce/session binding and schema validation.
- CSP, frame ancestors, and popup blockers have documented behavior.

### [ ] CHM-083 — Implement accessibility and basic customization

**Priority/Size:** P1 / M  
**Dependencies:** CHM-080

**Deliverable:** accessible, responsive hosted UI, themeable through safe configuration.

**Acceptance criteria:**

- Keyboard navigation and screen readers cover the journey.
- Branding does not allow arbitrary HTML/CSS.
- Error states offer clear recovery.

### [ ] CHM-084 — Create `@chameleon/react`

**Priority/Size:** P1 / L  
**Dependencies:** CHM-081, stable Etsy and eBay

**Deliverable:** `ChameleonProvider`, `ConnectMarketplaceButton`, and hooks.

**Acceptance criteria:**

- The React SDK wraps `connect-js` and does not duplicate the protocol.
- Supports SSR without accessing `window` during server-side render.
- The bundle contains no server-side code or secrets.

---

## Epic 9 — Chameleon webhooks for customers

### [ ] CHM-090 — Define the event catalog

**Priority/Size:** P1 / M  
**Dependencies:** CHM-031, CHM-053

**Deliverable:** `connection.created`, `connection.connected`, `connection.reauthorization_required`, `connection.disconnected`, and `connection.failed`.

### [ ] CHM-091 — Manage webhook endpoints and signing secrets

**Priority/Size:** P1 / M  
**Dependencies:** CHM-020, CHM-022

**Deliverable:** endpoints per environment with a secret displayed once, rotation, and status.

### [ ] CHM-092 — Implement the outbox and delivery worker

**Priority/Size:** P1 / L  
**Dependencies:** CHM-053, CHM-091

**Deliverable:** signed delivery, retries, jitter, and dead-letter.

**Acceptance criteria:**

- An event is only published after commit.
- Delivery is at-least-once and includes an event ID for deduplication.
- SSRF protections block unsafe destinations.

### [ ] CHM-093 — Provide signature verification in the Backend SDK

**Priority/Size:** P1 / M  
**Dependencies:** CHM-064, CHM-092

**Deliverable:** helper to verify raw body, timestamp, and signature.

---

## Epic 10 — eBay

### [ ] CHM-100 — Research current eBay OAuth and identity

**Priority/Size:** P0 / S  
**Dependencies:** CHM-076

### [ ] CHM-101 — Configure `EbayProvider` in the vault/runtime

**Priority/Size:** P0 / M  
**Dependencies:** CHM-100

### [ ] CHM-102 — Implement eBay authorization, scopes, and callback

**Priority/Size:** P0 / L  
**Dependencies:** CHM-101

### [ ] CHM-103 — Implement eBay exchange and refresh

**Priority/Size:** P0 / M  
**Dependencies:** CHM-102

### [ ] CHM-104 — Normalize eBay seller identity

**Priority/Size:** P0 / M  
**Dependencies:** CHM-103

### [ ] CHM-105 — Normalize eBay errors, rate limits, and revocation

**Priority/Size:** P0 / M  
**Dependencies:** CHM-101

### [ ] CHM-106 — Run eBay contract and integration tests

**Priority/Size:** P0 / L  
**Dependencies:** CHM-102 to CHM-105

### [ ] CHM-107 — Audit the abstraction after eBay

**Priority/Size:** P0 / M  
**Dependencies:** CHM-106

**Acceptance criteria:**

- Orchestrator, APIs, and SDKs have no Etsy/eBay conditionals.
- Adding eBay did not change provider-specific public shapes.
- Legitimate differences remain in capabilities/adapters.

### [-] CHM-108 — Validate real eBay

**Priority/Size:** P1 / S  
**Dependencies:** CHM-106  
**Expected blocker:** approved eBay application and seller

---

## Epic 11 — Walmart Marketplace US

### [ ] CHM-110 — Research current Walmart authentication

**Priority/Size:** P0 / M  
**Dependencies:** CHM-107

### [ ] CHM-111 — Configure `WalmartProvider` and capabilities

**Priority/Size:** P0 / M  
**Dependencies:** CHM-110

### [ ] CHM-112 — Implement Walmart authorization/lifecycle

**Priority/Size:** P0 / L  
**Dependencies:** CHM-111

### [ ] CHM-113 — Retrieve and normalize the Walmart US seller

**Priority/Size:** P0 / M  
**Dependencies:** CHM-112

### [ ] CHM-114 — Normalize Walmart errors and throttling

**Priority/Size:** P0 / M  
**Dependencies:** CHM-111

### [ ] CHM-115 — Test and document the Walmart sandbox

**Priority/Size:** P0 / L  
**Dependencies:** CHM-112 to CHM-114

### [-] CHM-116 — Validate real Walmart

**Priority/Size:** P1 / S  
**Dependencies:** CHM-115  
**Expected blocker:** Solution Provider approval and a US seller

---

## Epic 12 — Reliability, observability, and production

### [ ] CHM-120 — Standardize timeouts, retries, and circuit breaking

**Priority/Size:** P0 / L  
**Dependencies:** CHM-043, two working providers

### [ ] CHM-121 — Implement safe logs, metrics, and traces

**Priority/Size:** P0 / L  
**Dependencies:** CHM-005

**Acceptance criteria:**

- Correlation IDs link SDK, API, job, and provider request.
- Tokens, codes, cookies, keys, and sensitive PII are redacted.
- Metrics avoid per-seller/account cardinality.

### [ ] CHM-122 — Create an audit log of sensitive actions

**Priority/Size:** P0 / M  
**Dependencies:** CHM-033, CHM-121

### [ ] CHM-123 — Implement health/readiness and provider status

**Priority/Size:** P0 / M  
**Dependencies:** CHM-042, CHM-121

### [ ] CHM-124 — Run a security review and dependency audit

**Priority/Size:** P0 / L  
**Dependencies:** complete MVP

### [ ] CHM-125 — Test load, concurrency, and recovery

**Priority/Size:** P0 / L  
**Dependencies:** CHM-036, CHM-056, CHM-092

### [ ] CHM-126 — Define SLOs, alerts, and runbooks

**Priority/Size:** P1 / L  
**Dependencies:** CHM-121, CHM-123, CHM-125

---

## Epic 13 — TikTok Shop US

### [ ] CHM-130 — Research TikTok Shop US seller authorization

**Priority/Size:** P2 / M  
**Dependencies:** CHM-120

### [ ] CHM-131 — Configure `TikTokShopProvider`

**Priority/Size:** P2 / M  
**Dependencies:** CHM-130

### [ ] CHM-132 — Implement authorization, callback, and signing

**Priority/Size:** P2 / L  
**Dependencies:** CHM-131

### [ ] CHM-133 — Implement TikTok exchange and refresh

**Priority/Size:** P2 / M  
**Dependencies:** CHM-132

### [ ] CHM-134 — Normalize TikTok US shop identity

**Priority/Size:** P2 / M  
**Dependencies:** CHM-133

### [ ] CHM-135 — Implement errors/rate limits and tests

**Priority/Size:** P2 / L  
**Dependencies:** CHM-132 to CHM-134

### [-] CHM-136 — Validate real TikTok Shop US

**Priority/Size:** P2 / S  
**Dependencies:** CHM-135  
**Expected blocker:** approved partner app and US seller

---

## Epic 14 — Amazon US SP-API

Detailed backlog aligned with the hosted-first model: [TASKS-AMAZON.md](./TASKS-AMAZON.md).

### [ ] AMZ-001 — Research and model Amazon SP-API US

### [ ] AMZ-002 — Configure Amazon/LWA in the internal vault

### [ ] AMZ-003 — Implement seller authorization and hosted callback

### [ ] AMZ-004 — Implement LWA exchange/refresh

### [ ] AMZ-005 — Retrieve seller identity and marketplace IDs

### [ ] AMZ-006 — Isolate roles and Restricted Data Token

### [ ] AMZ-007 — Implement throttling, errors, and reconnect

### [ ] AMZ-008 — Run unit, contract, and integration tests

### [ ] AMZ-009 — Document setup and public behavior

### [-] AMZ-010 — Validate a real Amazon US seller

**Expected blocker:** approved SP-API application, roles, and US seller

---

## Epic 15 — Temu US

### [ ] CHM-150 — Research availability of the official Temu US API

**Priority/Size:** P2 / M  
**Dependencies:** CHM-120

**Acceptance criteria:**

- Confirms whether an official flow exists for partners to connect US sellers.
- If not, documents the limitation and does not use scraping/browser automation/unofficial endpoints.

### [ ] CHM-151 — Configure `TemuProvider` if officially supported

### [ ] CHM-152 — Implement Temu authorization and callback

### [ ] CHM-153 — Implement Temu credentials/signing/refresh

### [ ] CHM-154 — Normalize Temu US seller identity

### [ ] CHM-155 — Implement errors/rate limits and tests

### [-] CHM-156 — Validate real Temu US

**Expected blocker:** official partner access and an eligible US seller

---

## Epic 16 — Dashboard and Developer Experience

### [ ] CHM-160 — Create Application onboarding

**Priority/Size:** P1 / L  
**Dependencies:** CHM-020 to CHM-025

**Deliverable:** app creation, test/live environments, and initial key display.

### [ ] CHM-161 — Manage keys, origins, and redirects

**Priority/Size:** P1 / L  
**Dependencies:** CHM-160

### [ ] CHM-162 — Manage providers and configuration status

**Priority/Size:** P1 / M  
**Dependencies:** CHM-040, CHM-160

### [ ] CHM-163 — View organizations and connections

**Priority/Size:** P1 / L  
**Dependencies:** CHM-054, CHM-160

**Acceptance criteria:**

- Never shows access/refresh tokens.
- Sensitive actions require confirmation and go into the audit log.

### [ ] CHM-164 — Manage webhooks and delivery logs

**Priority/Size:** P1 / L  
**Dependencies:** CHM-091, CHM-092

### [ ] CHM-165 — Create documentation and quickstarts

**Priority/Size:** P0 / L  
**Dependencies:** CHM-064, CHM-081

**Deliverable:** quickstarts for the Backend SDK, Connect JS, React, webhooks, and each provider.

---

## Epic 17 — Future Universal Marketplace API

### [ ] CHM-170 — Define an internal executor per connection

**Priority/Size:** P2 / M  
**Dependencies:** three stable providers

### [ ] CHM-171 — Design orders/products/inventory capabilities

**Priority/Size:** P2 / L  
**Dependencies:** CHM-170

### [ ] CHM-172 — Design normalized resources without stabilizing prematurely

**Priority/Size:** P2 / L  
**Dependencies:** CHM-171

---

## Global Definition of Done

A ticket is only done when:

- the implementation and the OpenAPI contract are in sync;
- relevant unit, integration, contract, and type tests pass;
- isolation between applications/environments/organizations has been tested;
- Secret Keys and provider credentials remain exclusively server-side;
- tokens/codes/secrets do not appear in APIs, SDK returns, logs, traces, fixtures, or snapshots;
- critical mutating operations have defined idempotency;
- public changes have documentation, a changelog, and a SemVer assessment;
- a new provider passes the contract tests without adding specific logic to the orchestrator/SDKs.

## Recommended cut for the first MVP

```text
CHM-001…CHM-005
    ↓
CHM-010…CHM-014
    ↓
CHM-020…CHM-025
    ↓
CHM-030…CHM-035
    ↓
CHM-040…CHM-045
    ↓
CHM-050…CHM-055
    ↓
CHM-060…CHM-064
    ↓
CHM-070…CHM-077
    ↓
CHM-080…CHM-082
```

The first MVP is done when a customer installs `@chameleon/backend`, creates a Connect Session with their Secret Key, sends the user to Hosted Connect, and queries a completed Etsy connection without handling any Etsy credential.
