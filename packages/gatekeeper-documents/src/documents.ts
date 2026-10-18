import { DurableObject, RpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, ActionKind, AgentCatalog, ApprovalQueue, Gatekeeper,
  GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier,
  ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { DocumentRunner, documentScope } from "./runner.js";
import { DocumentSessionImpl } from "./session.js";
import type { DocumentSession } from "./types.js";
import TYPES_CODE from "./types.txt";

type AccountProps = { accountId: string };
const ICON = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path fill='currentColor' d='M7 2h12l6 6v22H7zm2 2v24h14V10h-6V4zm10 1v3h3zM11 14h10v2H11zm0 5h10v2H11z'/></svg>",
  ),
};

/** Account-local durable revocation blocks already minted sessions too. */
@validateRpc()
export class DocumentAccountState extends DurableObject<Cloudflare.Env> {
  async assertActive(): Promise<void> {
    if (await this.ctx.storage.get<boolean>("revoked")) throw new Error("Document account is revoked.");
  }
  async revoke(): Promise<void> {
    await this.ctx.storage.put("revoked", true);
  }
}

/** Native workspace facet. Its parent ID, never a caller argument, supplies the workspace scope. */
@validateRpc()
export class DocumentsGatekeeper extends DurableObject<Cloudflare.Env, AccountProps>
  implements Gatekeeper<DocumentSession> {
  async describe(): Promise<ResourceDescription> {
    return { url: "documents://pdf", title: "Documents", suggestedBindingName: "DOCUMENTS",
      snippet: "Inspect PDFs, extract complete page text, render pages, run OCR and parse native table structure.",
      tsType: "DocumentSession" };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<DocumentSession> {
    const workspaceId = this.ctx.id.toString();
    if (!workspaceId || workspaceId === this.ctx.props.accountId) throw new Error("Invalid workspace scope.");
    const state = this.ctx.exports.DocumentAccountState.getByName(this.ctx.props.accountId);
    await state.assertActive();
    const scope = await documentScope(this.ctx.props.accountId, workspaceId);
    const runner = new DocumentRunner({ url: this.env.DOCUMENT_RUNNER_URL,
      token: this.env.DOCUMENT_RUNNER_TOKEN }, scope);
    return new DocumentSessionImpl({ approvalQueue: approvalQueue.dup(), runner,
      assertActive: () => state.assertActive() });
  }
  async getAgentCatalog(): Promise<AgentCatalog | null> { return null; }
  /** Uploaded bytes belong to the workspace; configured collaborators may observe its results. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
  applyAction(_action: number): Promise<void> { throw new Error("Documents has no external write actions."); }
  rejectAction(_action: number): Promise<void> { throw new Error("Documents has no external write actions."); }
  revertAction(_action: number): Promise<void> { throw new Error("Documents has no external write actions."); }
}

/** Opaque provisioned account capability; provisioning mode belongs to the deployment admin. */
@validateRpc()
export class DocumentAccount extends WorkerEntrypoint<Cloudflare.Env, AccountProps>
  implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return { displayName: "Documents", avatar: ICON, singleton: { tsType: "DocumentSession" } };
  }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<DocumentSession>>> {
    return this.ctx.exports.DocumentsGatekeeper({ props: this.ctx.props });
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): never { throw new Error("Documents has no URL-addressed resources."); }
  startResourceConfigurator(_pattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Documents has no URL-addressed resources.");
  }
  async ensureResources(_patterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> {
    await this.ctx.exports.DocumentAccountState.getByName(this.ctx.props.accountId).revoke();
  }
  reconnect(): Promise<{ url: string }> { throw new Error("Documents has no credential reconnect flow."); }
  commitReconnect(_stageId: string): Promise<void> { throw new Error("Documents has no credential reconnect flow."); }
  async getAuthenticatedEmail(): Promise<string | null> { return null; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.DocumentVerifier({}); }
}

/** Collaborator verifier; document bytes are provided in the scoped workspace itself. */
@validateRpc()
export class DocumentVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

/** Native optional Documents vendor; installation does not grant capabilities by itself. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return { displayName: "Documents", url: "https://workers.cloudflare.com/", logo: ICON,
      tagline: "Read and process PDF documents", description: "Inspect, extract, render, OCR and parse PDF structure.",
      autoProvisionsAccount: true, providesAuth: false };
  }
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.DocumentAccount({ props: { accountId: crypto.randomUUID() } }) as Fetcher<GatekeeperUser>;
  }
  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("Documents uses optional account provisioning and has no OAuth flow.");
  }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}
