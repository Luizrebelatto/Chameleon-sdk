import assert from "node:assert/strict";
import test from "node:test";

import {
  AesGcmCredentialVault,
  AmazonConnectionService,
  AmazonProvider,
  AmazonProviderError,
  InMemoryConnectionEventSink,
  StaticSecretKeyAuthenticator,
  createAmazonHostedApi,
  createChameleonClient,
  type AmazonProviderConfig,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
  type IdGenerator,
} from "../src/index.ts";

class FixedClock implements Clock {
  public constructor(private current: Date) {}

  public now(): Date {
    return new Date(this.current);
  }

  public advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class SequenceIds implements IdGenerator {
  private counter = 0;

  public randomId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }
}

class AmazonFakeTransport implements HttpTransport {
  public readonly calls: HttpRequest[] = [];
  public includeUsMarketplace = true;
  public failRefresh = false;

  public async request(request: HttpRequest): Promise<HttpResponse> {
    this.calls.push(structuredClone(request));
    if (request.url === "https://api.amazon.com/auth/o2/token") {
      const form = new URLSearchParams(request.body);
      if (form.get("grant_type") === "refresh_token" && this.failRefresh) {
        return {
          status: 400,
          headers: { "x-amzn-requestid": "lwa-refresh-failure" },
          body: JSON.stringify({ error: "invalid_grant" }),
        };
      }
      if (form.get("grant_type") === "authorization_code") {
        assert.equal(form.get("code"), "spapi-code");
        assert.equal(form.get("redirect_uri"), "https://connect.chameleon.dev/v1/providers/amazon/callback");
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            access_token: "access-token-initial",
            refresh_token: "refresh-token-secret",
            token_type: "bearer",
            expires_in: 3_600,
          }),
        };
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: "access-token-refreshed",
          token_type: "bearer",
          expires_in: 3_600,
        }),
      };
    }

    if (request.url === "https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations") {
      return {
        status: 200,
        headers: { "x-amzn-requestid": "spapi-request-id" },
        body: JSON.stringify({
          payload: [
            ...(this.includeUsMarketplace
              ? [
                  {
                    marketplace: { id: "ATVPDKIKX0DER", countryCode: "US", name: "Amazon.com" },
                    participation: { isParticipating: true, hasSuspendedListings: false },
                  },
                ]
              : []),
            {
              marketplace: { id: "A2EUQ1WTGCTBG2", countryCode: "CA", name: "Amazon.ca" },
              participation: { isParticipating: true },
            },
          ],
        }),
      };
    }

    throw new Error(`Unexpected request ${request.method} ${request.url}`);
  }
}

function config(): AmazonProviderConfig {
  return {
    applicationId: "amzn1.sellerapps.app.example",
    lwaClientId: "amzn-client-id",
    lwaClientSecret: "lwa-client-secret",
    awsCredentials: {
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "aws-secret-example",
    },
    redirectUri: "https://connect.chameleon.dev/v1/providers/amazon/callback",
    loginUri: "https://connect.chameleon.dev/v1/providers/amazon/login",
    applicationVersion: "draft",
    userAgent: "Chameleon/0.1.0 (Language=TypeScript)",
  };
}

function buildService() {
  const clock = new FixedClock(new Date("2026-09-03T12:00:00.000Z"));
  const transport = new AmazonFakeTransport();
  const vault = new AesGcmCredentialVault(Buffer.alloc(32, 7).toString("base64"));
  const events = new InMemoryConnectionEventSink();
  const provider = new AmazonProvider(config(), transport, clock);
  const service = new AmazonConnectionService({
    provider,
    credentialVault: vault,
    eventSink: events,
    clock,
    ids: new SequenceIds(),
  });
  return { clock, events, provider, service, transport, vault };
}

test("completes the hosted Amazon callback flow without exposing credentials", async () => {
  const { events, service, transport, vault } = buildService();
  const started = await service.beginConnection({
    environmentId: "env_test",
    organizationId: "org_123",
    returnUrl: "https://app.example.com/integrations",
  });

  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.origin, "https://sellercentral.amazon.com");
  assert.equal(authorization.pathname, "/apps/authorize/consent");
  assert.equal(authorization.searchParams.get("application_id"), "amzn1.sellerapps.app.example");
  assert.equal(authorization.searchParams.get("version"), "beta");
  assert.equal(started.connection.status, "PENDING");

  const login = await service.handleLoginCallback({
    browserSessionId: started.browserSessionId,
    amazonCallbackUri: "https://sellercentral.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.example",
    amazonState: "amazon-csrf-state",
    sellingPartnerId: "A3SELLER123",
  });
  const confirmation = new URL(login.confirmationUrl);
  assert.equal(confirmation.searchParams.get("amazon_state"), "amazon-csrf-state");
  assert.equal(confirmation.searchParams.get("redirect_uri"), config().redirectUri);
  assert.equal(confirmation.searchParams.get("version"), "beta");

  const connected = await service.completeRedirectCallback({
    state: confirmation.searchParams.get("state")!,
    sellingPartnerId: "A3SELLER123",
    spapiOauthCode: "spapi-code",
  });
  assert.equal(connected.status, "CONNECTED");
  assert.equal(connected.account?.providerAccountId, "A3SELLER123");
  assert.deepEqual(connected.account?.marketplaceIds, ["ATVPDKIKX0DER", "A2EUQ1WTGCTBG2"]);
  assert.equal("refreshToken" in connected, false);
  assert.equal(JSON.stringify(connected).includes("refresh-token-secret"), false);

  const encrypted = vault.inspectEncryptedRecord(connected.id, {
    environmentId: "env_test",
    organizationId: "org_123",
    provider: "amazon",
  });
  assert.ok(encrypted);
  assert.equal(JSON.stringify(encrypted).includes("refresh-token-secret"), false);

  const spApiCall = transport.calls.find(
    (call) => call.url === "https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations",
  );
  if (!spApiCall) {
    assert.fail("Expected an SP-API marketplace participation call.");
  }
  assert.match(spApiCall.headers?.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//);
  assert.equal(spApiCall.headers?.["x-amz-access-token"], "access-token-initial");
  assert.deepEqual(
    events.events.map((event) => event.type),
    ["connection.pending", "connection.connected"],
  );

  const repeated = await service.completeRedirectCallback({
    state: confirmation.searchParams.get("state")!,
    sellingPartnerId: "A3SELLER123",
    spapiOauthCode: "spapi-code",
  });
  assert.deepEqual(repeated, connected);
});

test("rejects an untrusted Amazon confirmation callback URL", async () => {
  const { service } = buildService();
  const started = await service.beginConnection({
    environmentId: "env_test",
    organizationId: "org_123",
    returnUrl: "https://app.example.com/integrations",
  });

  await assert.rejects(
    service.handleLoginCallback({
      browserSessionId: started.browserSessionId,
      amazonCallbackUri: "https://attacker.example/apps/authorize/confirm/anything",
      amazonState: "attacker-state",
      sellingPartnerId: "A3SELLER123",
    }),
    (error: unknown) => error instanceof AmazonProviderError && error.code === "AMAZON_CALLBACK_INVALID",
  );
});

test("rejects a seller that is not active on Amazon US", async () => {
  const { service, transport } = buildService();
  transport.includeUsMarketplace = false;
  const started = await service.beginConnection({
    environmentId: "env_test",
    organizationId: "org_123",
    returnUrl: "https://app.example.com/integrations",
  });
  const login = await service.handleLoginCallback({
    browserSessionId: started.browserSessionId,
    amazonCallbackUri: "https://sellercentral.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.example",
    amazonState: "amazon-csrf-state",
    sellingPartnerId: "A3SELLER123",
  });

  await assert.rejects(
    service.completeRedirectCallback({
      state: new URL(login.confirmationUrl).searchParams.get("state")!,
      sellingPartnerId: "A3SELLER123",
      spapiOauthCode: "spapi-code",
    }),
    (error: unknown) => error instanceof AmazonProviderError && error.code === "AMAZON_AUTHORIZATION_DENIED",
  );
  assert.equal(service.getConnection(started.connection.id, "env_test", "org_123").status, "FAILED");
});

test("refreshes access tokens in the encrypted vault and flags an invalid grant", async () => {
  const { events, service, transport, vault } = buildService();
  const started = await service.beginConnection({
    environmentId: "env_test",
    organizationId: "org_123",
    returnUrl: "https://app.example.com/integrations",
  });
  const login = await service.handleLoginCallback({
    browserSessionId: started.browserSessionId,
    amazonCallbackUri: "https://sellercentral.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.example",
    amazonState: "amazon-csrf-state",
    sellingPartnerId: "A3SELLER123",
  });
  await service.completeRedirectCallback({
    state: new URL(login.confirmationUrl).searchParams.get("state")!,
    sellingPartnerId: "A3SELLER123",
    spapiOauthCode: "spapi-code",
  });

  await service.refreshConnection(started.connection.id, "env_test", "org_123");
  const refreshed = await vault.get(started.connection.id, {
    environmentId: "env_test",
    organizationId: "org_123",
    provider: "amazon",
  });
  assert.equal(refreshed?.accessToken, "access-token-refreshed");
  assert.equal(refreshed?.refreshToken, "refresh-token-secret");

  transport.failRefresh = true;
  await assert.rejects(
    service.refreshConnection(started.connection.id, "env_test", "org_123"),
    (error: unknown) => error instanceof AmazonProviderError && error.code === "AMAZON_CREDENTIALS_INVALID",
  );
  assert.equal(service.getConnection(started.connection.id, "env_test", "org_123").status, "REAUTHORIZATION_REQUIRED");
  assert.equal(events.events.at(-1)?.type, "connection.reauthorization_required");
});

test("disconnects idempotently and reconnects the same Chameleon connection", async () => {
  const { events, service, vault } = buildService();
  const started = await service.beginConnection({
    environmentId: "env_test",
    organizationId: "org_123",
    returnUrl: "https://app.example.com/integrations",
  });
  const login = await service.handleLoginCallback({
    browserSessionId: started.browserSessionId,
    amazonCallbackUri: "https://sellercentral.amazon.com/apps/authorize/confirm/amzn1.sellerapps.app.example",
    amazonState: "amazon-csrf-state",
    sellingPartnerId: "A3SELLER123",
  });
  await service.completeRedirectCallback({
    state: new URL(login.confirmationUrl).searchParams.get("state")!,
    sellingPartnerId: "A3SELLER123",
    spapiOauthCode: "spapi-code",
  });

  const disconnected = await service.disconnect(started.connection.id, "env_test", "org_123");
  assert.equal(disconnected.status, "DISCONNECTED");
  assert.equal(
    await vault.get(started.connection.id, {
      environmentId: "env_test",
      organizationId: "org_123",
      provider: "amazon",
    }),
    undefined,
  );
  const repeatedDisconnect = await service.disconnect(started.connection.id, "env_test", "org_123");
  assert.deepEqual(repeatedDisconnect, disconnected);

  const reconnect = await service.reconnect(started.connection.id, "env_test", "org_123");
  assert.equal(reconnect.connection.id, started.connection.id);
  assert.equal(reconnect.connection.status, "PENDING");
  assert.equal(reconnect.connection.account, undefined);
  assert.notEqual(reconnect.browserSessionId, started.browserSessionId);
  assert.match(reconnect.authorizationUrl, /sellercentral\.amazon\.com/);
  assert.equal(events.events.at(-1)?.type, "connection.pending");
});

test("backend SDK talks only to Chameleon Backend API", async () => {
  const requests: Request[] = [];
  const client = createChameleonClient({
    secretKey: "sk_test_secret",
    baseUrl: "https://api.chameleon.test/v1",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          id: "cs_123",
          connectionId: "conn_123",
          connectUrl: "https://connect.chameleon.test/session/cs_123",
          connectSessionToken: "cst_123",
          expiresAt: "2026-09-03T12:10:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const session = await client.connectSessions.create({
    organizationId: "org_123",
    provider: "amazon",
    returnUrl: "https://app.example.com/integrations",
    idempotencyKey: "request_123",
  });

  assert.equal(session.connectionId, "conn_123");
  assert.equal(requests[0]?.url, "https://api.chameleon.test/v1/connect_sessions");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer sk_test_secret");
  const requestBody = await requests[0]?.text();
  assert.equal(requestBody?.includes("lwaClientSecret"), false);
  assert.equal(requestBody?.includes("refreshToken"), false);
});

test("hosted API exchanges the frontend Connect Session token for a secure cookie before Amazon redirect", async () => {
  const { service } = buildService();
  const handler = createAmazonHostedApi({
    connectionService: service,
    authenticateSecretKey: new StaticSecretKeyAuthenticator(new Map([["sk_test_secret", { environmentId: "env_test" }]])),
    connectOrigin: "https://connect.chameleon.test",
    isAllowedReturnUrl: ({ returnUrl }) => returnUrl === "https://app.example.com/integrations",
  });
  const client = createChameleonClient({
    secretKey: "sk_test_secret",
    baseUrl: "https://api.chameleon.test/v1",
    fetch: async (input, init) => handler(new Request(input, init)),
  });

  const session = await client.connectSessions.create({
    organizationId: "org_123",
    provider: "amazon",
    returnUrl: "https://app.example.com/integrations",
  });
  const connectResponse = await handler(new Request(session.connectUrl, { redirect: "manual" }));

  assert.equal(connectResponse.status, 302);
  assert.match(connectResponse.headers.get("location") ?? "", /^https:\/\/sellercentral\.amazon\.com\//);
  assert.match(connectResponse.headers.get("set-cookie") ?? "", /HttpOnly; Secure; SameSite=Lax/);
  assert.equal((connectResponse.headers.get("location") ?? "").includes(session.connectSessionToken), false);
  assert.equal(connectResponse.headers.get("referrer-policy"), "no-referrer");
});

test("hosted API completes Amazon login and redirect callbacks without leaking tokens to the customer return URL", async () => {
  const { service } = buildService();
  const handler = createAmazonHostedApi({
    connectionService: service,
    authenticateSecretKey: new StaticSecretKeyAuthenticator(new Map([["sk_test_secret", { environmentId: "env_test" }]])),
    connectOrigin: "https://connect.chameleon.test",
    isAllowedReturnUrl: ({ returnUrl }) => returnUrl === "https://app.example.com/integrations",
  });
  const client = createChameleonClient({
    secretKey: "sk_test_secret",
    baseUrl: "https://api.chameleon.test/v1",
    fetch: async (input, init) => handler(new Request(input, init)),
  });

  const session = await client.connectSessions.create({
    organizationId: "org_123",
    provider: "amazon",
    returnUrl: "https://app.example.com/integrations",
  });
  const start = await handler(new Request(session.connectUrl, { redirect: "manual" }));
  const cookie = start.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  const login = await handler(
    new Request(
      "https://connect.chameleon.test/v1/providers/amazon/login?amazon_callback_uri=https%3A%2F%2Fsellercentral.amazon.com%2Fapps%2Fauthorize%2Fconfirm%2Famzn1.sellerapps.app.example&amazon_state=amazon-csrf-state&selling_partner_id=A3SELLER123",
      { headers: { cookie }, redirect: "manual" },
    ),
  );
  assert.equal(login.status, 302);
  const confirmationUrl = login.headers.get("location");
  assert.ok(confirmationUrl);
  const state = new URL(confirmationUrl).searchParams.get("state");
  assert.ok(state);

  const completed = await handler(
    new Request(
      `https://connect.chameleon.test/v1/providers/amazon/callback?state=${encodeURIComponent(state)}&selling_partner_id=A3SELLER123&spapi_oauth_code=spapi-code`,
      { redirect: "manual" },
    ),
  );
  assert.equal(completed.status, 302);
  const returnUrl = new URL(completed.headers.get("location")!);
  assert.equal(returnUrl.origin, "https://app.example.com");
  assert.equal(returnUrl.searchParams.get("connection_id"), session.connectionId);
  assert.equal(returnUrl.searchParams.get("connection_status"), "connected");
  assert.equal(returnUrl.searchParams.has("spapi_oauth_code"), false);
  assert.equal(returnUrl.searchParams.has("access_token"), false);
  assert.match(completed.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await client.connections.get(session.connectionId)).status, "CONNECTED");
});
