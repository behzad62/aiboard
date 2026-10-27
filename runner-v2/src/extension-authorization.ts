import { createHash, randomUUID } from "node:crypto";

import {
  EXTENSION_LIMITS,
  sameScope,
  type AccessSummary,
  type AuthorizationReceipt,
  type ExtensionChangePlan,
  type HumanInstallIntent,
  type InstallPolicy,
} from "./extension-management-contracts.js";
import { extractSourcesFromText, sourceKey, sourceKeyCovers, trustedPatternMatches } from "./extension-sources.js";

const MAX_INTENTS = 256;
const MAX_RECEIPTS = 512;

export type AuthorizationDecision =
  | { readonly kind: "authorized"; readonly receipt: AuthorizationReceipt }
  | { readonly kind: "needs_approval"; readonly reason: string };

/**
 * Mints authorization receipts. The only inputs are (a) an authenticated UI action, (b) the text of a
 * human message delivered by an authenticated Runner route, and (c) the user's standing policy. A
 * model's tool arguments, tool results, README/skill/MCP text and other third-party content never
 * reach this class, so they cannot create or broaden authority.
 */
export class ExtensionAuthorizer {
  private readonly intents = new Map<string, HumanInstallIntent>();
  private readonly receipts = new Map<string, AuthorizationReceipt>();
  /** Lower-cased human text per intent, used only to match lifecycle requests that name an item. */
  private readonly wordsByIntent = new Map<string, string>();

  constructor(private readonly options: { readonly projectRoot: string; readonly now?: () => Date }) {}

  /**
   * Records sources the human named. Called by the chat/build message routes with the human's own
   * message; returns the intent so the route can attach it to the conversation.
   */
  recordHumanMessage(conversationId: string, text: string): HumanInstallIntent | undefined {
    if (!conversationId || typeof text !== "string" || !text.trim()) return undefined;
    const sources = extractSourcesFromText(text.slice(0, 32_000), this.options.projectRoot);
    const names = [...text.matchAll(/\b(?:install|add|enable|connect|set up|setup|use|update|upgrade|remove|uninstall|disable|roll ?back)\b[^.\n]{0,120}/gi)].length > 0;
    if (sources.length === 0 && !names) return undefined;
    const now = this.now();
    const intent: HumanInstallIntent = Object.freeze({
      id: `intent_${randomUUID()}`,
      conversationId,
      textDigest: createHash("sha256").update(text).digest("hex"),
      sourceKeys: Object.freeze(sources.map((source) => sourceKey(source))),
      projectScope: /\b(this|the|current|our)\s+(project|repo|repository|workspace)\b|\bproject[- ]scoped?\b/i.test(text),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + EXTENSION_LIMITS.intentTtlMs).toISOString(),
    });
    this.intents.set(intent.id, intent);
    this.wordsByIntent.set(intent.id, text.toLowerCase().slice(0, 32_000));
    this.prune();
    return intent;
  }

  /** The most recent unexpired human intents for a conversation (newest first). */
  intentsFor(conversationId: string): HumanInstallIntent[] {
    this.prune();
    return [...this.intents.values()].filter((intent) => intent.conversationId === conversationId).reverse();
  }

  /** Whether the human's own words in this conversation name the item (used to let an agent pick among several). */
  humanMentioned(conversationId: string, name: string): boolean {
    const needle = name.toLowerCase();
    return needle.length >= 2 && this.intentsFor(conversationId).some((intent) => (this.wordsByIntent.get(intent.id) ?? "").includes(needle));
  }

  /** An authenticated UI action covering exactly this plan. */
  uiReceipt(plan: ExtensionChangePlan): AuthorizationReceipt {
    return this.mint(plan, "ui");
  }

  /**
   * Decides whether an agent-requested plan is already covered. Instruction-only skill installs named
   * by the human proceed under the default policy; executable code needs a trusted-source policy too;
   * anything else gets exactly one approval card.
   */
  decideForAgent(plan: ExtensionChangePlan, conversationId: string | undefined, policy: InstallPolicy, extensionName?: string): AuthorizationDecision {
    const intents = conversationId ? this.intentsFor(conversationId) : [];
    if (intents.length === 0) return { kind: "needs_approval", reason: "No message from you in this conversation asked for this change." };
    const covering = intents.find((intent) => this.intentCovers(intent, plan, extensionName));
    if (!covering) return { kind: "needs_approval", reason: plan.sourceKey ? "The source being installed is not one you named in this conversation." : `You did not ask to ${plan.action} "${plan.name}" in this conversation.` };
    if (covering.projectScope && plan.scope.kind === "user" && (plan.action === "install" || plan.action === "update")) {
      return { kind: "needs_approval", reason: "You asked for this project only; installing for every project needs your approval." };
    }
    if (plan.requiresExecutableTrust) {
      if (policy.humanRequestedExecutable !== "trusted_sources") return { kind: "needs_approval", reason: "This package runs code on your machine; your policy asks for approval." };
      const trusted = plan.sourceKey && policy.trustedSources.some((pattern) => trustedPatternMatches(pattern, plan.sourceKey!));
      if (!trusted) return { kind: "needs_approval", reason: "This package runs code on your machine and its source is not in your trusted sources." };
      return { kind: "authorized", receipt: this.mint(plan, "standing_policy", covering.id) };
    }
    if (plan.action === "install" || plan.action === "update") {
      if (policy.humanRequestedSkills !== "auto") return { kind: "needs_approval", reason: "Your policy asks for approval before installing skills." };
    }
    return { kind: "authorized", receipt: this.mint(plan, "human_message", covering.id) };
  }

  /** Validates that a stored receipt still covers the plan being applied (same digest, scope, unexpired). */
  verify(receiptId: string, plan: ExtensionChangePlan): boolean {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return false;
    if (Date.parse(receipt.expiresAt) <= this.now().getTime()) return false;
    return receipt.planDigest === plan.planDigest && receipt.action === plan.action && sameScope(receipt.scope, plan.scope) &&
      receipt.accessDigest === accessDigest(plan.access) && receipt.sourceKey === plan.sourceKey && receipt.extensionId === plan.extensionId;
  }

  receipt(id: string): AuthorizationReceipt | undefined {
    return this.receipts.get(id);
  }

  private intentCovers(intent: HumanInstallIntent, plan: ExtensionChangePlan, extensionName?: string): boolean {
    if (plan.sourceKey && (plan.action === "install" || plan.action === "update")) {
      return intent.sourceKeys.some((granted) => sourceKeyCovers(granted, plan.sourceKey!));
    }
    // Lifecycle changes on an installed item: the human must have named it.
    const words = this.wordsByIntent.get(intent.id) ?? "";
    const name = (extensionName ?? plan.name).toLowerCase();
    const verbs: Record<string, RegExp> = {
      enable: /\b(enable|turn on|activate)\b/, disable: /\b(disable|turn off|deactivate)\b/, remove: /\b(remove|uninstall|delete)\b/,
      rollback: /\b(roll ?back|revert|previous version)\b/, test: /\b(test|check|verify)\b/, revoke_credentials: /\b(revoke|sign out|log out|disconnect)\b/,
    };
    return name.length >= 2 && words.includes(name) && (verbs[plan.action]?.test(words) ?? false);
  }

  private mint(plan: ExtensionChangePlan, origin: AuthorizationReceipt["origin"], intentId?: string): AuthorizationReceipt {
    const now = this.now();
    const receipt: AuthorizationReceipt = Object.freeze({
      id: `auth_${randomUUID()}`,
      origin,
      action: plan.action,
      scope: plan.scope,
      ...(plan.sourceKey ? { sourceKey: plan.sourceKey } : {}),
      ...(plan.extensionId ? { extensionId: plan.extensionId } : {}),
      planDigest: plan.planDigest,
      accessDigest: accessDigest(plan.access),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + EXTENSION_LIMITS.receiptTtlMs).toISOString(),
      ...(intentId ? { intentId } : {}),
    });
    this.receipts.set(receipt.id, receipt);
    this.prune();
    return receipt;
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, intent] of this.intents) if (Date.parse(intent.expiresAt) <= now) { this.intents.delete(id); this.wordsByIntent.delete(id); }
    for (const [id, receipt] of this.receipts) if (Date.parse(receipt.expiresAt) <= now) this.receipts.delete(id);
    while (this.intents.size > MAX_INTENTS) { const id = this.intents.keys().next().value!; this.intents.delete(id); this.wordsByIntent.delete(id); }
    while (this.receipts.size > MAX_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function accessDigest(access: AccessSummary): string {
  return createHash("sha256").update(JSON.stringify(access)).digest("hex");
}
