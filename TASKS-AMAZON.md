# Backlog — Amazon US SP-API in Chameleon

This backlog implements Amazon as an internal provider of Chameleon's hosted-first platform. The Developer Experience follows the Clerk style: the customer installs SDKs and uses Chameleon keys; Amazon credentials, callbacks, tokens, and refresh stay in Chameleon's infrastructure.

## Expected public experience

### Customer backend

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

### Customer frontend

```tsx
<ConnectMarketplaceButton connectSessionToken={session.connectSessionToken} />
```

### Internal flow

```text
Customer Backend SDK
        │ Secret Key
        ▼
Chameleon Backend API ── creates ──► Connect Session
                                         │
Customer Frontend ── Publishable Key ────┘
        │
        ▼
Chameleon Hosted Connect
        │
        ▼
Amazon Seller Authorization
        │
        ▼
Chameleon Hosted Callback
        │
        ├── validates state
        ├── exchanges authorization code
        ├── stores refresh token in Credential Vault
        ├── resolves seller/marketplace identity
        └── emits connection.connected
```

## Architecture rules

- The customer only uses Chameleon's `pk_test/pk_live` and `sk_test/sk_live`.
- Amazon application credentials and LWA secrets never enter the public SDK.
- The callback registered with Amazon belongs to a Chameleon domain.
- Authorization codes and LWA tokens are never sent to the customer's return URL.
- `AmazonProvider` runs only in internal services.
- LWA, SP-API, role, region, marketplace ID, and RDT specifics do not enter the generic domain.
- Test and live use isolated applications/configurations/credentials.
- BYOC (bring your own Amazon application) is out of the MVP.

## Platform prerequisites

- Backend API authenticated by Secret Key.
- Frontend API resolved by Publishable Key.
- Ephemeral Connect Sessions.
- Hosted Connect and hosted callback.
- Persisted Organization, Connection, and MarketplaceAccount.
- Credential Vault with KMS/envelope encryption.
- Single-use OAuth transaction store.
- Distributed lock, queue, retry, and observability.
- Provider Registry and contract tests.
- Etsy and eBay have already validated the abstraction.

## Conventions

- Status: `[ ]` pending, `[-]` externally blocked, `[x]` done.
- `P0`: blocks Amazon Connect; `P1`: required for production; `P2`: later capability.
- `S`: up to 1 day; `M`: 1–3 days; `L`: needs refinement.

## Current implementation

Implemented and validated locally with mocked transports: `AMZ-001`, `AMZ-003`, `AMZ-011` to `AMZ-013`, `AMZ-020` to `AMZ-021`, `AMZ-023`, `AMZ-030` to `AMZ-032`, `AMZ-040` to `AMZ-042`, `AMZ-050`, `AMZ-052`, `AMZ-070`, `AMZ-080`, `AMZ-082`, and `AMZ-083`.

The checkpoint includes the provider, Hosted Connect handler, two-step callback, LWA, AES-256-GCM vault, AWS SigV4 signing, Sellers API, backend SDK, and tests. The remaining items require production infrastructure (KMS/DB/outbox/locks/worker/UI/webhook), Amazon approval, or capabilities still outside the MVP.

---

## Epic A — Amazon research, approval, and architecture

### [x] AMZ-001 — Research current seller authorization and LWA

**Priority/Size:** P0 / M  
**Dependencies:** none

**Deliverable:** versioned document of the official flow for a public application to connect Amazon US sellers.

**Acceptance criteria:**

- Uses only current official documentation, with links and access dates.
- Records endpoints, parameters, callback, tokens, expirations, and refresh.
- Distinguishes public, private, draft/test, and production applications where applicable.
- Identifies steps blocked by approval without blocking mocks and internal implementation.

### [ ] AMZ-002 — Document the SP-API application and approval process

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-001

**Deliverable:** operational checklist for Chameleon's application with Amazon.

**Acceptance criteria:**

- Lists the registration, profile, use case, roles, URLs, and policies officially required.
- Separates engineering, security, legal/compliance, and operations actions.
- Does not direct Chameleon customers to create Amazon applications in the MVP.
- Flags external dependencies and lead times without inventing deadlines.

### [x] AMZ-003 — Map regions and marketplace IDs

**Priority/Size:** P0 / S  
**Dependencies:** AMZ-001

**Deliverable:** typed internal configuration for Amazon US.

**Acceptance criteria:**

- Endpoint region and marketplace ID are distinct concepts.
- US configuration is centralized and validated.
- Adding Canada/Mexico in the future does not require changing public APIs.

### [ ] AMZ-004 — Map minimum roles and permissions

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-001, AMZ-002

**Deliverable:** capability → role/permission matrix.

**Acceptance criteria:**

- Connection and seller identity request only the minimum required.
- Orders, finance, and restricted data are not part of the MVP consent.
- A missing role has an error distinct from an invalid credential.

### [ ] AMZ-005 — Update the threat model for Amazon

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-001 to AMZ-004

**Deliverable:** threats and controls for the application secret, callback, LWA refresh token, seller ID, and RDT.

**Acceptance criteria:**

- Covers CSRF/replay, confused deputy, tenant mix-up, and callback manipulation.
- Defines minimum plaintext access and mandatory redaction.
- Reviews return URLs to prevent authorization code leakage/open redirect.

---

## Epic B — Internal configuration and provider

### [ ] AMZ-010 — Store the Amazon application configuration in the vault

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-002, credential vault ready

**Deliverable:** application ID, LWA client credentials, and other secrets per environment.

**Acceptance criteria:**

- Test/staging/live are isolated.
- Plaintext is only accessible to the authorized Amazon runtime.
- Changes produce an audit event.
- No Amazon configuration is returned by the public dashboard/API/SDK.

### [x] AMZ-011 — Implement Amazon configuration validation

**Priority/Size:** P0 / S  
**Dependencies:** AMZ-003, AMZ-010

**Deliverable:** internal parser that fails early on invalid combinations.

**Acceptance criteria:**

- Validates environment, region, callback, and required official fields.
- Errors do not display sensitive values.
- An unavailable provider does not appear as enabled in Hosted Connect.

### [x] AMZ-012 — Create `AmazonProvider`

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-011, `MarketplaceProvider` contract

**Deliverable:** adapter registered in the internal runtime.

**Acceptance criteria:**

- The provider's public ID is `amazon`.
- Backend SDK and orchestrator do not get Amazon branches.
- Optional capabilities are declared by the provider.
- The module is not bundled into `@chameleon/backend` or `@chameleon/react`.

### [x] AMZ-013 — Create internal LWA and SP-API HTTP clients

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-012

**Deliverable:** separate clients using the shared HTTP runtime.

**Acceptance criteria:**

- Support timeout, AbortSignal, request ID, retry hooks, and a fake transport.
- Authorization headers, client secret, and sensitive bodies are redacted.
- Responses have schema validation and a size limit.

---

## Epic C — Hosted seller authorization

### [x] AMZ-020 — Enable Amazon in Connect Sessions

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-012, Connect Session API ready

**Deliverable:** `provider: "amazon"` accepted by the Backend API/SDK when the environment is configured.

**Acceptance criteria:**

- The customer Secret Key identifies the application/environment.
- Organization, return URL, and provider are bound to the ephemeral token.
- The session expires and contains no Amazon credential.
- A disabled provider returns an actionable error.

### [x] AMZ-021 — Generate the seller authorization URL

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-013, AMZ-020

**Deliverable:** `getAuthorizationUrl()` according to the current official flow.

**Acceptance criteria:**

- Uses the Chameleon callback and the application ID of the correct environment.
- CSPRNG state references a single-use server-side OAuth transaction.
- The browser cannot freely choose organization, connection, or callback.
- The URL has encoding and parameter tests.

### [ ] AMZ-022 — Show Amazon in Hosted Connect

**Priority/Size:** P0 / S  
**Dependencies:** AMZ-020, Hosted Connect ready

**Deliverable:** Amazon confirmation/redirect state in the hosted UI.

**Acceptance criteria:**

- Displays environment, marketplace, and organization safely.
- Loading, cancellation, and unavailable provider are handled.
- The UI never receives the Secret Key, LWA secret, or provider token.

### [x] AMZ-023 — Process the Amazon Hosted Callback

**Priority/Size:** P0 / L  
**Dependencies:** AMZ-021, callback orchestrator ready

**Deliverable:** parsing and validation of the official parameters returned by Amazon.

**Acceptance criteria:**

- Validates and consumes state atomically.
- Checks the expected environment, provider, connection, and transaction.
- Handles denied/cancelled consent with safe status and error.
- The authorization code stays only in the Chameleon backend.

### [ ] AMZ-024 — Ensure an idempotent and transactional callback

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-023, distributed lock/idempotency ready

**Deliverable:** protection against repeated, concurrent callbacks and partial failure.

**Acceptance criteria:**

- State cannot be consumed twice.
- Does not duplicate connection/account.
- A failure before the vault does not produce `CONNECTED` status.
- A safe internal retry can resume finalization when applicable.

---

## Epic D — LWA tokens and credential lifecycle

### [x] AMZ-030 — Exchange the authorization code for LWA tokens

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-013, AMZ-023

**Deliverable:** server-to-server code exchange in the Chameleon runtime.

**Acceptance criteria:**

- Uses client credentials from the vault and the registered redirect.
- Normalizes refresh/access token, expiration, and required internal metadata.
- An incomplete/malformed response produces a typed error.
- Tokens do not appear in events, redirects, SDK returns, logs, or snapshots.

### [x] AMZ-031 — Encrypt and persist seller credentials

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-030, credential vault ready

**Deliverable:** credential envelope bound to environment/connection/provider.

**Acceptance criteria:**

- The refresh token reaches the database encrypted.
- Associated data prevents swapping ciphertext between tenants/connections.
- The envelope has a key version and timestamps.
- The write participates in the transactional finalization strategy.

### [x] AMZ-032 — Implement LWA access token generation/refresh

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-031, refresh worker ready

**Deliverable:** proactive and on-demand refresh within the platform.

**Acceptance criteria:**

- Uses an injected clock and a margin before expiration.
- A distributed lock prevents refresh storms.
- A new refresh token is persisted atomically when rotated.
- A definitive invalid grant marks `REAUTHORIZATION_REQUIRED`.

### [ ] AMZ-033 — Implement a secure access token cache

**Priority/Size:** P1 / M  
**Dependencies:** AMZ-032

**Deliverable:** short-lived, optional internal cache.

**Acceptance criteria:**

- TTL is shorter than the official validity.
- Cache misses/degradation do not break correctness.
- Cache keys do not expose seller/token.
- Nearly expired tokens are not handed to the executor.

---

## Epic E — Seller identity and connection

### [x] AMZ-040 — Define the canonical source of seller identity

**Priority/Size:** P0 / S  
**Dependencies:** AMZ-001, AMZ-030

**Deliverable:** ADR identifying the official data used for seller ID and authorized marketplaces.

**Acceptance criteria:**

- Does not use display name as a stable identity.
- Documents whether data comes from the callback, token context, or an official endpoint.
- Defines behavior for an authorization without a US marketplace.

### [x] AMZ-041 — Retrieve seller/account identity

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-032, AMZ-040

**Deliverable:** implementation of `getAccount()` in the provider.

**Acceptance criteria:**

- Retrieves a stable identifier and authorized marketplaces.
- Uses only the documented minimum permissions.
- Raw payload does not cross the provider boundary.

### [x] AMZ-042 — Normalize `MarketplaceAccount`

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-041

**Deliverable:** public account with provider account ID, display name/country when available, and marketplace IDs.

**Acceptance criteria:**

- Amazon metadata stays internal/typed.
- The same organization can have multiple Amazon sellers.
- Reconnecting the same seller does not duplicate the account.
- No token or sensitive role appears in the public object.

### [ ] AMZ-043 — Finalize the connection and publish an event

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-024, AMZ-031, AMZ-042

**Deliverable:** transition to `CONNECTED` and `connection.connected` event via outbox.

**Acceptance criteria:**

- The event is only visible after commit.
- SDK get/list sees the normalized account.
- Hosted Connect returns success without a provider credential.

---

## Epic F — Reconnect, disconnect, errors, and throttling

### [x] AMZ-050 — Normalize LWA/SP-API errors

**Priority/Size:** P0 / L  
**Dependencies:** AMZ-013

**Deliverable:** mapper for config, consent, invalid grant, auth, roles, throttling, and unavailability.

**Acceptance criteria:**

- The public error contains code, provider, retryable, and Chameleon request ID.
- A missing role is distinguished from an expired/revoked credential.
- Sensitive cause is restricted, redacted, and auditable.

### [ ] AMZ-051 — Implement throttling and retry hints

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-050, retry runtime ready

**Deliverable:** interpretation of the official signals in the operations used by the provider.

**Acceptance criteria:**

- Honors the official retry delay when present.
- Uses backoff with jitter and a maximum budget.
- Does not repeat code exchange or non-idempotent operations without a guarantee.

### [x] AMZ-052 — Implement Amazon reconnect

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-020 to AMZ-043

**Deliverable:** new Connect Session/transaction for a connection that requires reauthorization.

**Acceptance criteria:**

- Never reuses a previous state/code.
- Keeps the Chameleon connection ID when the policy allows.
- The same seller updates credentials/account atomically.

### [ ] AMZ-053 — Implement Amazon disconnect/revocation

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-043

**Deliverable:** idempotent disconnect and official revocation when supported.

**Acceptance criteria:**

- Blocks refresh/execution immediately after the transition.
- Local credentials follow the destruction/retention policy.
- Remote failure has explicit behavior and produces a safe event.

---

## Epic G — Isolated Restricted Data Token

### [ ] AMZ-060 — Define an internal RDT capability

**Priority/Size:** P2 / M  
**Dependencies:** AMZ-004, AMZ-032

**Deliverable:** future contract to request a token per protected resource.

**Acceptance criteria:**

- RDT does not enter the generic `ProviderCredentials` or `MarketplaceAccount`.
- Resource/scope is mandatory and least-privilege.
- The token is not persisted by default and has a strict TTL.
- Amazon Connect works without this capability.

### [ ] AMZ-061 — Implement a mockable RDT client

**Priority/Size:** P2 / M  
**Dependencies:** AMZ-060

**Deliverable:** internal client that does not export the raw token in public SDKs.

---

## Epic H — Backend SDK, Hosted Connect, and webhooks

### [x] AMZ-070 — Expose Amazon in Backend SDK types

**Priority/Size:** P0 / S  
**Dependencies:** AMZ-020

**Deliverable:** `provider: "amazon"` in create/filter/result and the corresponding documentation.

**Acceptance criteria:**

- The SDK sends calls only to the Chameleon Backend API.
- Does not add LWA config, SP-API secret, or a callback handler to the customer.

### [ ] AMZ-071 — Expose Amazon in Connect JS/React

**Priority/Size:** P1 / S  
**Dependencies:** AMZ-022, frontend SDK ready

**Deliverable:** label/logo/status and generic events.

**Acceptance criteria:**

- The UI contains no Amazon-specific flow beyond presentation metadata.
- The return contains connection ID/status, never code/token.

### [ ] AMZ-072 — Deliver Amazon events via the generic webhook

**Priority/Size:** P1 / M  
**Dependencies:** AMZ-043, AMZ-052, AMZ-053, webhook system ready

**Deliverable:** connected, reauthorization required, disconnected, and failed.

**Acceptance criteria:**

- The payload uses the generic connection schema.
- Delivery is signed, at-least-once, and deduplicable by event ID.
- No provider credential enters the payload.

---

## Epic I — Tests, documentation, and validation

### [x] AMZ-080 — Create provider unit tests

**Priority/Size:** P0 / L  
**Dependencies:** AMZ-020 to AMZ-053

**Deliverable:** tests for authorization URL, callback, exchange, refresh, identity, errors, and disconnect.

**Acceptance criteria:**

- Uses a fake HTTP transport and fake clock; no network access.
- Covers success, denial, invalid state, malformed payload, invalid grant, and throttling.
- Verifies redaction in errors/logs/snapshots.

### [ ] AMZ-081 — Run provider contract tests

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-080

**Deliverable:** Amazon passes the same suite as Etsy/eBay according to capabilities.

**Acceptance criteria:**

- Orchestrator, Backend API, and SDKs have no Amazon branches.
- Unsupported capabilities are declared, not simulated.

### [x] AMZ-082 — Create a mocked end-to-end hosted integration

**Priority/Size:** P0 / L  
**Dependencies:** AMZ-070, AMZ-071, AMZ-080, AMZ-081

**Deliverable:** Customer Backend SDK → Connect Session → Hosted Connect → callback → vault → account → webhook.

**Acceptance criteria:**

- Validates isolation between two environments and two organizations.
- Confirms ciphertext in the database and absence of tokens on public surfaces.
- Exercises duplicate callback, concurrent refresh, and partial failure.

### [x] AMZ-083 — Document Amazon Connect for customers

**Priority/Size:** P1 / M  
**Dependencies:** AMZ-070 to AMZ-082

**Deliverable:** quickstart using only Chameleon keys, SDK, and Hosted Connect.

**Acceptance criteria:**

- The customer does not need to understand LWA, SP-API refresh, or provider secrets.
- Explains states, reconnect, webhooks, and public errors.
- Distinguishes test/live and seller requirements.

### [ ] AMZ-084 — Create an Amazon operational runbook

**Priority/Size:** P1 / M  
**Dependencies:** AMZ-050, AMZ-051, observability ready

**Deliverable:** diagnosis of provider outage, invalid credentials, approval/role failure, throttling, and refresh storm.

### [-] AMZ-090 — Validate with a real Amazon US seller

**Priority/Size:** P0 / M  
**Dependencies:** AMZ-082, approved SP-API application  
**Expected blocker:** Amazon approval, appropriate roles, and a US test seller

**Acceptance criteria:**

- The seller completes authorization through Hosted Connect.
- The Chameleon callback exchanges the code and stores the refresh token in the vault.
- The Backend SDK queries normalized connection/account.
- Refresh, reconnect, disconnect, and webhook are validated.
- Evidence is sanitized and contains no token, code, secret, or unnecessary PII.

---

## Recommended order

```text
AMZ-001…AMZ-005
      ↓
AMZ-010…AMZ-013
      ↓
AMZ-020…AMZ-024
      ↓
AMZ-030…AMZ-033
      ↓
AMZ-040…AMZ-043
      ↓
AMZ-050…AMZ-053
      ↓
AMZ-070…AMZ-072
      ↓
AMZ-080…AMZ-084
      ↓
AMZ-090
```

`AMZ-060` and `AMZ-061` only come in when a future operation actually requires restricted data.

## Amazon Definition of Done

Amazon Connect is ready when:

- the customer uses only Chameleon Publishable/Secret Keys;
- all authorization happens through Hosted Connect and the Chameleon callback;
- application secrets and seller tokens stay in the credential vault;
- seller identity and US marketplace IDs are normalized;
- Backend SDK, frontend SDK, and webhooks expose only Chameleon resources;
- refresh, reconnect, disconnect, throttling, and failures have safe behavior;
- unit, contract, integration, and security tests pass;
- the core abstraction contains no Amazon-specific logic;
- real validation is complete or is the only item blocked by external approval.
