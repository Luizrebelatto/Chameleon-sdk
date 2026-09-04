# Amazon SP-API implementation notes

## Sources

- [Amazon SP-API Postman collection supplied for this project](https://www.postman.com/amazon-selling-partner-api/selling-partner-api/documentation/41642916-701a2571-e326-4fbf-aa23-d03810dbec39)
- [Website authorization workflow](https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow)
- [Connecting to SP-API](https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api)
- [SP-API endpoints](https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints)

## Implemented scope

- Public seller-authorization URL for Seller Central US.
- Hosted login and redirect callback state machine.
- `spapi_oauth_code` exchange at `https://api.amazon.com/auth/o2/token`.
- Refresh-token exchange for short-lived LWA access tokens.
- AES-256-GCM encrypted credential vault with scoped associated data.
- AWS SigV4 signing for SP-API requests.
- Sellers API `GET /sellers/v1/marketplaceParticipations` to normalize a marketplace account.
- Reconnect, disconnect, typed errors, idempotent final callback, and retry hints.

## Platform-owned configuration

The values below belong only in the Chameleon platform secret manager. They must never be configured in a customer application or returned by any SDK:

- Amazon application ID
- LWA client ID and client secret
- AWS access key, secret access key, and optional session token
- seller refresh and access tokens
- credential-vault master key

## Amazon US defaults

- Seller Central authorization origin: `https://sellercentral.amazon.com`
- SP-API endpoint: `https://sellingpartnerapi-na.amazon.com`
- AWS signing region: `us-east-1`
- AWS service: `execute-api`
- US marketplace ID: `ATVPDKIKX0DER`

For a Draft Amazon application, the authorization URL includes `version=beta`. Production omits that parameter.

## Hosted callback routing

Amazon's website authorization workflow has two callback stages:

1. Amazon calls the registered Chameleon **login URI** with `amazon_callback_uri`, `amazon_state`, and `selling_partner_id`.
2. Chameleon validates its browser-bound Connect Session, creates a single-use final state, and redirects the seller to Amazon's callback URI.
3. Amazon calls Chameleon's registered **redirect URI** with `state`, `selling_partner_id`, and `spapi_oauth_code`.
4. Chameleon validates and consumes state, exchanges the code within Amazon's short validity window, persists credentials encrypted, and discovers marketplace participation.

The short-lived Connect Session token returned by the Backend API is used only to open Hosted Connect. The HTTP layer immediately exchanges it for a Secure, HttpOnly, SameSite=Lax cookie owned by the Chameleon Hosted Connect domain, then removes it from the URL by redirecting to Amazon. It must also send `Referrer-Policy: no-referrer` on the callback routes.

## Real validation blocker

The implementation is fully testable with mocks. A real end-to-end validation still needs an approved public SP-API application, registered Chameleon callback URLs, the required roles, and a US seller test account.
