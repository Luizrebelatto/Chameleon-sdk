# Chameleon Marketplace Connections

Hosted, Clerk-style infrastructure for connecting marketplace sellers without exposing tokens, callbacks, AWS credentials, or provider application secrets. Amazon SP-API US is the only operational adapter in this reference.

## What changed

- Recoverable `ConnectionAttempt` bound to environment, workspace, user, and intent.
- External account authorization, permissions/resources, and `SyncState` are now separate states.
- Frontend API with Publishable Key + Chameleon session + workspace RBAC.
- Browser-safe client with `connect()` so the UI can open Hosted Connect without creating its own `POST` route.
- Optional Amazon marketplace selection before activating the connection.
- Callback/reconnect credentials are staged and encrypted until the seller and resources are validated.
- Explicit catalog for Amazon, eBay, TikTok Shop, Temu, and Walmart; only Amazon is enabled.

See the [architecture and migration plan](./docs/marketplace-architecture.md) for contracts, limitations, and official sources.

## Frontend usage

> This repository is still private and does not publish npm packages. The client below is the API that will make up `@chameleon/frontend` or `@chameleon/react`; use the equivalent internal alias/artifact until it is published.

```tsx
"use client";

import { createChameleonFrontendClient } from "@chameleon/frontend";

declare function getChameleonSessionToken(): Promise<string>;

const chameleon = createChameleonFrontendClient({
  publishableKey: process.env.NEXT_PUBLIC_CHAMELEON_PUBLISHABLE_KEY!,
  // Chameleon's own session proof, obtained through your auth adapter.
  sessionToken: getChameleonSessionToken,
});

export function ConnectAmazonButton() {
  return (
    <button
      onClick={() =>
        chameleon.connect({
          provider: "amazon",
          organizationId: "org_of_signed_in_company",
          returnUrl: "https://app.example.com/integrations",
        })
      }
    >
      Connect Amazon
    </button>
  );
}
```

`connect()` creates the attempt and navigates to Hosted Connect. The UI never performs code exchange, token refresh, SP-API signing, or token storage. The Chameleon server must resolve the user from the session, validate their permission in the workspace, and allow the browser origin via CORS.

After consent, the `returnUrl` receives only safe data:

```text
https://app.example.com/integrations?connection_id=conn_123&connection_status=connected&attempt_id=attempt_123
```

To track a pending selection, query the attempt and the connection from the backend. The connection returns `authorizationStatus`, `resources`, `permissions`, and `syncState`; it never returns Amazon credentials.

## Backend usage (compatibility)

```ts
import { createChameleonClient } from "@chameleon/backend";

const chameleon = createChameleonClient({
  secretKey: process.env.CHAMELEON_SECRET_KEY!,
});

const session = await chameleon.connectSessions.create({
  organizationId: "org_of_signed_in_company",
  provider: "amazon",
  returnUrl: "https://app.example.com/integrations",
  idempotencyKey: crypto.randomUUID(),
});

const connection = await chameleon.connections.get(session.connectionId);

if (connection.resources.some((resource) => !resource.selected)) {
  await chameleon.connections.selectResources(
    connection.id,
    connection.resources.filter((resource) => resource.providerResourceId === "ATVPDKIKX0DER").map((resource) => resource.id),
  );
}
```

`sk_` never belongs in the browser. The Backend API is useful for administrative jobs, reading connections, and products that prefer to create the session on their own backend.

## Internal Chameleon configuration

The HTTP handler is framework-neutral (`Request`/`Response`). Wire in real Secret Key authentication, Chameleon sessions, workspace RBAC, and return/origin allowlists:

```ts
const api = createAmazonHostedApi({
  connectionService: connections,
  connectOrigin: "https://connect.chameleon.dev",
  authenticateSecretKey: secretKeyAuthenticator,
  authenticateFrontendSession: chameleonSessionAuthenticator,
  workspaceAuthorizer: chameleonWorkspaceAuthorizer,
  isAllowedFrontendOrigin: (origin) => origin === "https://app.example.com",
  isAllowedReturnUrl: ({ returnUrl }) => returnUrl === "https://app.example.com/integrations",
});
```

Available routes:

- `POST /v1/frontend/connect_sessions` — browser: `pk_` + Chameleon session.
- `GET /v1/frontend/connections/:id`, `POST /resources`, `/reconnect`, and `/disconnect` — authenticated UI.
- `GET /v1/frontend/connection_attempts/:id` and `POST /cancel` — recoverable state in the UI.
- `POST /v1/connect_sessions` — backend: `sk_`.
- `GET /v1/marketplaces` — provider/capability catalog for the backend.
- `GET /v1/connection_attempts/:id` and `POST /v1/connection_attempts/:id/cancel`.
- `GET /v1/connections/:id`, `POST /v1/connections/:id/resources`, `/reconnect`, and `/disconnect`.
- `GET /connect/amazon` and internal callbacks under `/v1/providers/amazon/*`.

Amazon settings and encryption keys live exclusively in the platform's secret manager. See [.env.example](./.env.example) and [docs/amazon-sp-api.md](./docs/amazon-sp-api.md).

## Marketplace status

| Provider | Status |
| --- | --- |
| Amazon US | Implemented with mocks: hosted authorization, LWA, SigV4, marketplace discovery, refresh, reconnect, selection, and disconnect |
| eBay | Documented in the registry; adapter not configured |
| TikTok Shop | Documented in the registry; adapter not configured |
| Temu | Documented in the registry; adapter not configured |
| Walmart | Documented in the registry; adapter not configured |

## Development and testing

Requires Node.js 22.6 or later.

```bash
npm install
npm run typecheck
npm test
npm run check
```

Tests are mocked, with no network access or real credentials. The [Bruno](./bruno/README.md) collection covers the Backend API contract. Real Amazon validation still requires an approved public SP-API application, registered HTTPS callbacks, appropriate roles, and a US test seller.
