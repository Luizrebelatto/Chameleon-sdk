import type {
  MarketplaceAdapter,
  MarketplaceProviderDescriptor,
  MarketplaceProviderId,
} from "./types.ts";

/** Internal registry; public SDKs receive only descriptors, never adapters. */
export class MarketplaceProviderRegistry {
  private readonly adapters = new Map<MarketplaceProviderId, MarketplaceAdapter>();

  public constructor(adapters: readonly MarketplaceAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.descriptor.id)) {
        throw new Error(`Marketplace provider ${adapter.descriptor.id} was registered more than once.`);
      }
      this.adapters.set(adapter.descriptor.id, adapter);
    }
  }

  public get(provider: MarketplaceProviderId): MarketplaceAdapter | undefined {
    return this.adapters.get(provider);
  }

  public list(): MarketplaceProviderDescriptor[] {
    return [...this.adapters.values()].map((adapter) => structuredClone(adapter.descriptor));
  }
}
