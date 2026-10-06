# Amazon Connect — Chameleon contract

## Preferred UI flow

The browser uses `createChameleonFrontendClient` with a Publishable Key and a Chameleon session proof. Calling `connect()` creates a `ConnectionAttempt` and redirects to Hosted Connect. The `Secret Key`, LWA, SP-API, AWS SigV4, and callbacks stay out of the client application.

The Frontend API only accepts the action if the session authenticator identifies the user and `WorkspaceAuthorizer` grants `connection:create` for the workspace. An `organizationId` received from the browser is not enough to establish ownership.

## Public states

- Attempt: `awaiting_authorization` → `processing` → `completed`, or `awaiting_selection`, `failed`, `cancelled`/`expired`.
- Persistent authorization: `PENDING`, `CONNECTED`, `REAUTHORIZATION_REQUIRED`, `DISCONNECTED`, or `FAILED`.
- Sync: `NOT_STARTED`, `QUEUED`, `SYNCING`, `HEALTHY`, `DEGRADED`, `FAILED`, or `DISABLED`.

An import failure changes `syncState`, not `authorizationStatus`. Logging out of the Chameleon session does not disconnect the seller either.

## Resources and reconnection

Amazon discovers active marketplaces via `GET /sellers/v1/marketplaceParticipations`. In configurations with `requireResourceSelection`, credentials stay encrypted in a temporary attempt scope until the UI calls `POST /v1/connections/:id/resources` with the chosen resource IDs.

On reconnect, the returned seller must match the known `providerAccountId` before new credentials replace the current ones. Callbacks from an old attempt or a disconnected connection fail on correlation/state checks and do not reactivate the integration.

## Data returned to the UI

The safe return contains `connection_id`, `connection_status`, and `attempt_id`. Connection queries may include the normalized account, resources, known permissions, and sync. They never include `spapi_oauth_code`, the LWA access token, the refresh token, AWS credentials, or the Amazon application secret.

## Production

Replace the in-memory components with a transactional database, KMS/envelope encryption, a single-use store for attempts/callbacks, distributed locks for refresh, an outbox, and workers. The first sync must be enqueued only after the connection is activated; it must not run inside the HTTP callback.

Official details of the Amazon flow are in [amazon-sp-api.md](./amazon-sp-api.md). The multi-provider overview is in [marketplace-architecture.md](./marketplace-architecture.md).
