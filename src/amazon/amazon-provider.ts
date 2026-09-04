import { signSpApiRequest } from "./aws-sigv4.ts";
import { AmazonProviderError, toAmazonProviderError } from "./errors.ts";
import { parseJsonResponse } from "./http.ts";
import type {
  AmazonProviderConfig,
  Clock,
  HttpTransport,
  LoginCallbackInput,
  LwaTokenResponse,
  MarketplaceParticipationsResponse,
  PublicMarketplaceAccount,
  RedirectCallbackInput,
} from "./types.ts";

export const AMAZON_US_MARKETPLACE_ID = "ATVPDKIKX0DER";
export const AMAZON_NA_SP_API_ENDPOINT = "https://sellingpartnerapi-na.amazon.com";
export const AMAZON_NA_AWS_REGION = "us-east-1";
const LWA_TOKEN_ENDPOINT = "https://api.amazon.com/auth/o2/token";

export interface AmazonAuthorizationRequest {
  state: string;
}

export interface AmazonLoginCallback {
  amazonCallbackUri: string;
  amazonState: string;
  sellingPartnerId: string;
  version?: string | undefined;
}

export interface AmazonRedirectCallback {
  state: string;
  sellingPartnerId: string;
  spapiOauthCode: string;
}

export class AmazonProvider {
  public readonly id = "amazon" as const;
  private readonly sellerCentralBaseUrl: string;
  private readonly spApiBaseUrl: string;
  private readonly awsRegion: string;

  public constructor(
    private readonly config: AmazonProviderConfig,
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
  ) {
    validateAmazonProviderConfig(config);
    this.sellerCentralBaseUrl = config.sellerCentralBaseUrl ?? "https://sellercentral.amazon.com";
    this.spApiBaseUrl = config.spApiBaseUrl ?? AMAZON_NA_SP_API_ENDPOINT;
    this.awsRegion = config.awsRegion ?? AMAZON_NA_AWS_REGION;
  }

  public getAuthorizationUrl(input: AmazonAuthorizationRequest): string {
    if (!input.state) {
      throw new AmazonProviderError("AMAZON_STATE_INVALID", "An Amazon authorization state is required.");
    }

    const url = new URL("/apps/authorize/consent", this.sellerCentralBaseUrl);
    url.searchParams.set("application_id", this.config.applicationId);
    url.searchParams.set("state", input.state);
    if (this.config.applicationVersion === "draft") {
      url.searchParams.set("version", "beta");
    }
    return url.toString();
  }

  /**
   * Handles the first callback sent by Amazon to the registered Chameleon login
   * URI. The caller must authenticate the browser session before invoking this.
   */
  public createConfirmationUrl(input: AmazonLoginCallback, state: string): string {
    this.assertTrustedAmazonCallbackUri(input.amazonCallbackUri);
    if (!input.amazonState || !input.sellingPartnerId || !state) {
      throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Amazon login callback is missing required parameters.");
    }

    const url = new URL(input.amazonCallbackUri);
    url.searchParams.set("amazon_state", input.amazonState);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    if (this.config.applicationVersion === "draft") {
      url.searchParams.set("version", "beta");
    }
    return url.toString();
  }

  public parseRedirectCallback(input: RedirectCallbackInput): AmazonRedirectCallback {
    if (!input.state || !input.sellingPartnerId || !input.spapiOauthCode) {
      throw new AmazonProviderError(
        "AMAZON_CALLBACK_INVALID",
        "Amazon redirect callback is missing state, seller ID, or authorization code.",
      );
    }
    return {
      state: input.state,
      sellingPartnerId: input.sellingPartnerId,
      spapiOauthCode: input.spapiOauthCode,
    };
  }

  public async exchangeAuthorizationCode(code: string): Promise<LwaTokenResponse> {
    return this.requestLwaToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
        client_id: this.config.lwaClientId,
        client_secret: this.config.lwaClientSecret,
      }),
      "authorization code exchange",
      true,
    );
  }

  public async refreshAccessToken(refreshToken: string): Promise<LwaTokenResponse> {
    return this.requestLwaToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.config.lwaClientId,
        client_secret: this.config.lwaClientSecret,
      }),
      "access token refresh",
      false,
    );
  }

  public async getMarketplaceParticipations(accessToken: string): Promise<MarketplaceParticipationsResponse> {
    const url = new URL("/sellers/v1/marketplaceParticipations", this.spApiBaseUrl).toString();
    const headers = signSpApiRequest({
      method: "GET",
      url,
      credentials: this.config.awsCredentials,
      region: this.awsRegion,
      now: this.clock.now(),
      headers: {
        accept: "application/json",
        "user-agent": this.config.userAgent,
        "x-amz-access-token": accessToken,
      },
    });
    const response = await this.transport.request({ method: "GET", url, headers });
    if (response.status < 200 || response.status >= 300) {
      throw toAmazonProviderError("marketplace participation lookup", response.status, response.headers);
    }
    const parsed = parseJsonResponse<MarketplaceParticipationsResponse>(response, "marketplace participation lookup");
    if (!Array.isArray(parsed.payload)) {
      throw new AmazonProviderError(
        "AMAZON_PROVIDER_UNAVAILABLE",
        "Amazon returned marketplace participations in an unexpected format.",
        { retryable: true },
      );
    }
    return parsed;
  }

  public normalizeAccount(
    sellingPartnerId: string,
    participations: MarketplaceParticipationsResponse,
    accountId: string,
  ): PublicMarketplaceAccount {
    const activeParticipations = participations.payload.filter((entry) => entry.participation.isParticipating);
    const marketplaceIds = activeParticipations.map((entry) => entry.marketplace.id);
    const usParticipation = activeParticipations.find((entry) => entry.marketplace.id === AMAZON_US_MARKETPLACE_ID);
    if (!usParticipation) {
      throw new AmazonProviderError(
        "AMAZON_AUTHORIZATION_DENIED",
        "The authorized Amazon seller is not participating in the US marketplace.",
      );
    }

    return {
      id: accountId,
      provider: "amazon",
      providerAccountId: sellingPartnerId,
      country: usParticipation.marketplace.countryCode ?? "US",
      marketplaceIds,
      metadata: {
        regionalEndpoint: this.spApiBaseUrl,
        activeMarketplaceCount: marketplaceIds.length,
        hasSuspendedUsListings: usParticipation.participation.hasSuspendedListings ?? false,
      },
    };
  }

  private async requestLwaToken(
    body: URLSearchParams,
    operation: string,
    requiresRefreshToken: boolean,
  ): Promise<LwaTokenResponse> {
    const response = await this.transport.request({
      method: "POST",
      url: LWA_TOKEN_ENDPOINT,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: body.toString(),
    });

    if (response.status < 200 || response.status >= 300) {
      throw toAmazonProviderError(operation, response.status, response.headers);
    }

    const parsed = parseJsonResponse<LwaTokenResponse>(response, operation);
    if (
      typeof parsed.access_token !== "string" ||
      parsed.access_token.length === 0 ||
      parsed.token_type.toLowerCase() !== "bearer" ||
      !Number.isFinite(parsed.expires_in) ||
      parsed.expires_in <= 0 ||
      (requiresRefreshToken && (!parsed.refresh_token || typeof parsed.refresh_token !== "string"))
    ) {
      throw new AmazonProviderError("AMAZON_TOKEN_EXCHANGE_FAILED", `Amazon returned an invalid ${operation} response.`);
    }
    return parsed;
  }

  private assertTrustedAmazonCallbackUri(rawCallbackUri: string): void {
    let callback: URL;
    let sellerCentral: URL;
    try {
      callback = new URL(rawCallbackUri);
      sellerCentral = new URL(this.sellerCentralBaseUrl);
    } catch (cause) {
      throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Amazon callback URI is invalid.", { cause });
    }

    if (
      callback.protocol !== "https:" ||
      callback.hostname !== sellerCentral.hostname ||
      !callback.pathname.startsWith("/apps/authorize/confirm/")
    ) {
      throw new AmazonProviderError("AMAZON_CALLBACK_INVALID", "Amazon callback URI is not trusted.");
    }
  }
}

export function validateAmazonProviderConfig(config: AmazonProviderConfig): void {
  const required = [
    ["applicationId", config.applicationId],
    ["lwaClientId", config.lwaClientId],
    ["lwaClientSecret", config.lwaClientSecret],
    ["awsCredentials.accessKeyId", config.awsCredentials.accessKeyId],
    ["awsCredentials.secretAccessKey", config.awsCredentials.secretAccessKey],
    ["redirectUri", config.redirectUri],
    ["loginUri", config.loginUri],
    ["userAgent", config.userAgent],
  ] as const;
  const missing = required.filter(([, value]) => value.trim().length === 0).map(([name]) => name);
  if (missing.length > 0) {
    throw new AmazonProviderError(
      "AMAZON_CONFIGURATION_INVALID",
      `Amazon configuration is missing: ${missing.join(", ")}.`,
    );
  }

  for (const [name, rawUrl] of [
    ["redirectUri", config.redirectUri],
    ["loginUri", config.loginUri],
    ["sellerCentralBaseUrl", config.sellerCentralBaseUrl ?? "https://sellercentral.amazon.com"],
    ["spApiBaseUrl", config.spApiBaseUrl ?? AMAZON_NA_SP_API_ENDPOINT],
  ] as const) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:") {
        throw new Error("non-HTTPS URL");
      }
    } catch (cause) {
      throw new AmazonProviderError("AMAZON_CONFIGURATION_INVALID", `${name} must be a valid HTTPS URL.`, {
        cause,
      });
    }
  }

  if (config.userAgent.length > 500) {
    throw new AmazonProviderError("AMAZON_CONFIGURATION_INVALID", "Amazon user-agent must be 500 characters or fewer.");
  }
}
