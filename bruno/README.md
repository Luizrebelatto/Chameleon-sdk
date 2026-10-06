# Bruno — Amazon Connections

Bruno collection for testing Chameleon's hosted API for Amazon SP-API.

## Setup

1. Open the `bruno/` folder in Bruno.
2. Select the **local** environment and edit the values in `environments/local.bru`:
   - `baseUrl`: origin that forwards the `createAmazonHostedApi` routes;
   - `secretKey`: a valid test Chameleon Secret Key;
   - `organizationId`: test organization;
   - `returnUrl`: URL previously allowed by `isAllowedReturnUrl`.
3. Run the requests in the order shown by their numbers.

`01-create-amazon-connect-session` saves `attemptId`, `connectionId`, and `connectUrl` as runtime variables. The following requests automatically reuse the same IDs.

## Hosted Connect and Amazon

`02-manual-open-hosted-connect` only checks the first `302` and stores the Seller Central URL in `sellerCentralUrl`. It must be opened in a browser, where the seller will sign in and consent with Amazon.

The callback flow is not automated by the collection: it requires an approved SP-API application, registered HTTPS URIs, and a real/test seller account. Never try to fill in `spapi_oauth_code`, LWA tokens, or AWS credentials in Bruno; they belong to the Chameleon infrastructure.

## Safe smoke-test sequence

1. Create Amazon Connect Session
2. Get Connection Attempt
3. Get Pending Connection
4. MANUAL - Open Hosted Connect (optional; do not include it in the Collection Runner)
5. Disconnect Connection
6. Reconnect Connection
7. Get Reconnected Connection

The assertions also confirm that connection responses do not contain Amazon tokens.
