export type AmazonErrorCode =
  | "AMAZON_CONFIGURATION_INVALID"
  | "AMAZON_CALLBACK_INVALID"
  | "AMAZON_STATE_INVALID"
  | "AMAZON_STATE_EXPIRED"
  | "AMAZON_STATE_CONSUMED"
  | "AMAZON_AUTHORIZATION_DENIED"
  | "AMAZON_TOKEN_EXCHANGE_FAILED"
  | "AMAZON_CREDENTIALS_INVALID"
  | "AMAZON_RATE_LIMITED"
  | "AMAZON_PROVIDER_UNAVAILABLE"
  | "AMAZON_CONNECTION_NOT_FOUND"
  | "AMAZON_CONNECTION_CONFLICT";

export interface AmazonErrorOptions {
  retryable?: boolean | undefined;
  retryAfterMs?: number | undefined;
  requestId?: string | undefined;
  cause?: unknown;
}

export class AmazonProviderError extends Error {
  public readonly name = "AmazonProviderError";

  public constructor(
    public readonly code: AmazonErrorCode,
    message: string,
    public readonly options: AmazonErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
  }
}

export function toAmazonProviderError(
  operation: string,
  status: number,
  responseHeaders: Record<string, string | undefined>,
  cause?: unknown,
): AmazonProviderError {
  const requestId = responseHeaders["x-amzn-requestid"] ?? responseHeaders["x-amz-request-id"];
  const retryAfterHeader = responseHeaders["retry-after"];
  const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1_000 : undefined;

  if (status === 429) {
    const options: AmazonErrorOptions = {
      retryable: true,
      requestId,
      cause,
    };
    if (Number.isFinite(retryAfterMs)) {
      options.retryAfterMs = retryAfterMs;
    }
    return new AmazonProviderError("AMAZON_RATE_LIMITED", `Amazon rate limited ${operation}.`, options);
  }

  if (status >= 500) {
    return new AmazonProviderError("AMAZON_PROVIDER_UNAVAILABLE", `Amazon failed ${operation}.`, {
      retryable: true,
      requestId,
      cause,
    });
  }

  if (status === 400 || status === 401 || status === 403) {
    return new AmazonProviderError("AMAZON_CREDENTIALS_INVALID", `Amazon rejected ${operation}.`, {
      requestId,
      cause,
    });
  }

  return new AmazonProviderError("AMAZON_TOKEN_EXCHANGE_FAILED", `Amazon failed ${operation}.`, {
    requestId,
    cause,
  });
}
