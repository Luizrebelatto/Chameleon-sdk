import type { HttpRequest, HttpResponse, HttpTransport } from "./types.ts";

export class FetchHttpTransport implements HttpTransport {
  public async request(request: HttpRequest): Promise<HttpResponse> {
    const init: RequestInit = { method: request.method };
    if (request.headers) {
      init.headers = request.headers;
    }
    if (request.body !== undefined) {
      init.body = request.body;
    }
    if (request.signal) {
      init.signal = request.signal;
    }
    const response = await fetch(request.url, init);
    const headers: Record<string, string | undefined> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers,
      body: await response.text(),
    };
  }
}

export function parseJsonResponse<T>(response: HttpResponse, operation: string): T {
  try {
    return JSON.parse(response.body) as T;
  } catch (cause) {
    throw new Error(`Amazon returned an invalid JSON response for ${operation}.`, { cause });
  }
}
