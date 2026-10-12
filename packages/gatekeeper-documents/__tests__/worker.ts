import { DurableObject } from "cloudflare:workers";
import type { DocumentAccount } from "../src/documents.js";
import { documentScope } from "../src/runner.js";
export { default } from "../src/worker.js";
export * from "../src/worker.js";
// ctx.exports analysis requires direct exports in the test worker.
export { DocumentAccount, DocumentVerifier } from "../src/documents.js";

/** Exercise inherited scope with real workerd facets, rather than caller-supplied identity. */
export class ScopeFacet extends DurableObject {
  async scope(accountId: string): Promise<string> {
    return documentScope(accountId, this.ctx.id.toString());
  }
}
/** Test-only parent for sibling facet and cross-workspace namespace comparisons. */
export class ScopeParent extends DurableObject {
  /** Exercise the persistent account capability storage used by native provisioning. */
  async persistedAccount(): Promise<string | undefined> {
    const exports = this.ctx.exports as unknown as {
      DocumentAccount(options: { props: { accountId: string } }): Fetcher<DocumentAccount>;
    };
    const account = exports.DocumentAccount({ props: { accountId: "test-account" } });
    await this.ctx.storage.put("account", account);
    const restored = await this.ctx.storage.get<Fetcher<DocumentAccount>>("account");
    return (await restored?.describe())?.displayName;
  }
  async scope(facetName: string, accountId: string): Promise<string> {
    const exports = this.ctx.exports as unknown as { ScopeFacet: DurableObjectClass<ScopeFacet> };
    const facet = this.ctx.facets.get<ScopeFacet>(facetName, () => ({ class: exports.ScopeFacet }));
    return facet.scope(accountId);
  }
}
