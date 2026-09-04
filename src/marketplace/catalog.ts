import type { MarketplaceAdapter, MarketplaceProviderDescriptor } from "./types.ts";

function unavailable(descriptor: MarketplaceProviderDescriptor): MarketplaceAdapter {
  return { descriptor };
}

/**
 * Confirmed capability catalogue. Only Amazon is enabled by this repository;
 * the remaining entries make their product state explicit without fabricating
 * endpoints, scopes, token lifetimes, or credential formats.
 */
export const documentedMarketplaceAdapters: readonly MarketplaceAdapter[] = [
  unavailable({
    id: "ebay",
    availability: "not_configured",
    capabilities: {
      authorization: ["oauth"],
      supportsPkce: false,
      supportsRefresh: true,
      supportsRemoteRevocation: false,
      supportsResourceSelection: false,
      supportsAppStoreInitiatedInstall: false,
      requiresAdditionalResourceIdentifier: false,
    },
    documentationUrl: "https://developer.ebay.com/develop/guides/sell/authorization",
  }),
  unavailable({
    id: "tiktok_shop",
    availability: "not_configured",
    capabilities: {
      authorization: ["oauth"],
      supportsPkce: false,
      supportsRefresh: true,
      supportsRemoteRevocation: false,
      supportsResourceSelection: true,
      supportsAppStoreInitiatedInstall: false,
      requiresAdditionalResourceIdentifier: true,
    },
    documentationUrl: "https://partner.tiktokshop.com/docv2/page/api-entity-tags",
  }),
  unavailable({
    id: "temu",
    availability: "not_configured",
    capabilities: {
      authorization: ["app_store_callback", "manual_credential"],
      supportsPkce: false,
      supportsRefresh: false,
      supportsRemoteRevocation: false,
      supportsResourceSelection: true,
      supportsAppStoreInitiatedInstall: true,
      requiresAdditionalResourceIdentifier: false,
    },
    documentationUrl: "https://partner.temu.com/documentation?menu_code=38e79b35d2cb463d85619c1c786dd303",
  }),
  unavailable({
    id: "walmart",
    availability: "not_configured",
    capabilities: {
      authorization: ["oauth", "app_store_callback"],
      supportsPkce: false,
      supportsRefresh: true,
      supportsRemoteRevocation: false,
      supportsResourceSelection: false,
      supportsAppStoreInitiatedInstall: true,
      requiresAdditionalResourceIdentifier: false,
    },
    documentationUrl: "https://developer.walmart.com/us-marketplace/docs/oauth-20-authorization",
  }),
];
