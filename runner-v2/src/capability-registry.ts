import type {
  NativeTool,
  ToolDefinition,
} from "./agent-contracts.js";
import {
  parseLanguageProviderDescriptor,
  type LanguageIntelligenceProvider,
  type LanguageProviderDescriptor,
} from "./language-intelligence.js";
import {
  PROTECTED_RUNNER_LIFECYCLE_TOOL_NAMES,
  RUNNER_EXTENSION_CONTEXT_MAX_BYTES,
  type RunnerExtensionCapabilities,
  type RunnerExtensionContextContributor,
  type RunnerExtensionInstance,
  type RunnerExtensionManifest,
  type RunnerExtensionTool,
} from "./runner-extension.js";

export interface RunnerExtensionRegistration {
  manifest: RunnerExtensionManifest;
  instance: RunnerExtensionInstance;
}

export interface RegisteredExtensionTool {
  extensionId: string;
  tool: RunnerExtensionTool;
}

export interface RegisteredContextContributor {
  extensionId: string;
  contributor: RunnerExtensionContextContributor;
}

export interface RegisteredLanguageProvider {
  extensionId: string;
  descriptor: LanguageProviderDescriptor;
  provider: LanguageIntelligenceProvider;
}

export interface CapabilityRegistryOptions {
  reservedToolNames?: readonly string[];
}

export class CapabilityRegistry {
  private readonly extensionManifests: RunnerExtensionManifest[];
  private readonly extensionTools: RegisteredExtensionTool[];
  private readonly extensionContext: RegisteredContextContributor[];
  private readonly extensionLanguages: RegisteredLanguageProvider[];

  constructor(
    registrations: readonly RunnerExtensionRegistration[],
    options: CapabilityRegistryOptions = {},
  ) {
    const reserved = new Set(options.reservedToolNames ?? []);
    const ids = new Set<string>();
    const toolNames = new Set<string>();
    const contextIds = new Set<string>();
    const languageIds = new Set<string>();
    const manifests: RunnerExtensionManifest[] = [];
    const tools: RegisteredExtensionTool[] = [];
    const context: RegisteredContextContributor[] = [];
    const languages: RegisteredLanguageProvider[] = [];

    for (const registration of registrations) {
      const { manifest, instance } = registration;
      if (ids.has(manifest.id)) {
        throw new Error(`Duplicate extension id ${manifest.id}.`);
      }
      assertExtensionInstance(manifest.id, instance);
      const capabilities = instance.capabilities();
      assertCapabilitiesShape(manifest.id, capabilities);
      assertDeclaredCapabilities(manifest, capabilities);
      ids.add(manifest.id);
      manifests.push(cloneManifest(manifest));

      for (const candidate of capabilities.tools) {
        const tool = snapshotTool(manifest.id, candidate as NativeTool);
        const name = tool.definition.name;
        if (reserved.has(name)) {
          throw new Error(`Extension ${manifest.id} registered reserved tool ${name}.`);
        }
        if (toolNames.has(name)) {
          throw new Error(`Duplicate tool ${name} was registered by an extension.`);
        }
        toolNames.add(name);
        tools.push({ extensionId: manifest.id, tool });
      }

      for (const candidate of capabilities.contextContributors) {
        const contributor = snapshotContextContributor(manifest.id, candidate);
        if (contextIds.has(contributor.id)) {
          throw new Error(
            `Duplicate context contributor ${contributor.id} was registered by an extension.`,
          );
        }
        contextIds.add(contributor.id);
        context.push({ extensionId: manifest.id, contributor });
      }

      for (const candidate of capabilities.languageProviders) {
        const registered = snapshotLanguageProvider(manifest.id, candidate);
        if (languageIds.has(registered.descriptor.id)) {
          throw new Error(
            `Duplicate language provider ${registered.descriptor.id} was registered by an extension.`,
          );
        }
        languageIds.add(registered.descriptor.id);
        languages.push(registered);
      }
    }

    this.extensionManifests = manifests;
    this.extensionTools = tools;
    this.extensionContext = context;
    this.extensionLanguages = languages;
  }

  manifests(): RunnerExtensionManifest[] {
    return this.extensionManifests.map(cloneManifest);
  }

  tools(): RegisteredExtensionTool[] {
    return this.extensionTools.map((item) => ({ ...item }));
  }

  contextContributors(): RegisteredContextContributor[] {
    return this.extensionContext.map((item) => ({ ...item }));
  }

  languageProviders(): RegisteredLanguageProvider[] {
    return this.extensionLanguages.map((item) => ({
      ...item,
      descriptor: cloneLanguageDescriptor(item.descriptor),
    }));
  }
}

function assertExtensionInstance(
  extensionId: string,
  instance: RunnerExtensionInstance,
): void {
  if (
    typeof instance !== "object" ||
    instance === null ||
    typeof instance.capabilities !== "function" ||
    typeof instance.start !== "function" ||
    typeof instance.close !== "function"
  ) {
    throw new Error(`Extension ${extensionId} did not create a valid instance.`);
  }
}

function assertCapabilitiesShape(
  extensionId: string,
  capabilities: RunnerExtensionCapabilities,
): void {
  if (
    typeof capabilities !== "object" ||
    capabilities === null ||
    !Array.isArray(capabilities.tools) ||
    !Array.isArray(capabilities.contextContributors) ||
    !Array.isArray(capabilities.languageProviders)
  ) {
    throw new Error(`Extension ${extensionId} returned invalid capabilities.`);
  }
}

function assertDeclaredCapabilities(
  manifest: RunnerExtensionManifest,
  capabilities: RunnerExtensionCapabilities,
): void {
  const actual = [
    ...(capabilities.tools.length > 0 ? ["tools" as const] : []),
    ...(capabilities.contextContributors.length > 0 ? ["context" as const] : []),
    ...(capabilities.languageProviders.length > 0
      ? ["language_intelligence" as const]
      : []),
  ];
  if (
    actual.length !== manifest.capabilities.length ||
    actual.some((kind, index) => kind !== manifest.capabilities[index])
  ) {
    throw new Error(
      `Extension ${manifest.id} capabilities do not match its manifest declaration.`,
    );
  }
}

function snapshotTool(extensionId: string, input: NativeTool): RunnerExtensionTool {
  if (typeof input !== "object" || input === null) {
    throw new Error(`Extension ${extensionId} returned an invalid tool.`);
  }
  const definition = input.definition;
  assertToolDefinition(extensionId, definition);
  if (definition.lifecycle === true) {
    throw new Error(
      `Extension ${extensionId} cannot register lifecycle tool ${definition.name}.`,
    );
  }
  if (
    (PROTECTED_RUNNER_LIFECYCLE_TOOL_NAMES as readonly string[]).includes(
      definition.name,
    )
  ) {
    throw new Error(
      `Extension ${extensionId} cannot register protected lifecycle tool ${definition.name}.`,
    );
  }
  if (typeof input.validate !== "function" || typeof input.execute !== "function") {
    throw new Error(`Extension tool ${definition.name} has invalid handlers.`);
  }
  if (input.assessAccess !== undefined && typeof input.assessAccess !== "function") {
    throw new Error(`Extension tool ${definition.name} has invalid access assessment.`);
  }
  const validate = input.validate.bind(input);
  const execute = input.execute.bind(input);
  const assessAccess = input.assessAccess?.bind(input);
  const tool: RunnerExtensionTool = {
    definition: Object.freeze({
      name: definition.name,
      description: definition.description,
      inputSchema: deepFreeze(structuredClone(definition.inputSchema)),
      readOnly: definition.readOnly,
      effect: definition.effect,
    }),
    validate,
    ...(assessAccess ? { assessAccess } : {}),
    execute,
  };
  return Object.freeze(tool);
}

function assertToolDefinition(
  extensionId: string,
  definition: ToolDefinition,
): void {
  if (typeof definition !== "object" || definition === null) {
    throw new Error(`Extension ${extensionId} returned a tool without a definition.`);
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(definition.name)) {
    throw new Error(`Extension tool name ${String(definition.name)} is invalid.`);
  }
  if (
    typeof definition.description !== "string" ||
    !definition.description.trim()
  ) {
    throw new Error(`Extension tool ${definition.name} requires a description.`);
  }
  if (
    typeof definition.inputSchema !== "object" ||
    definition.inputSchema === null ||
    Array.isArray(definition.inputSchema)
  ) {
    throw new Error(`Extension tool ${definition.name} requires an input schema.`);
  }
  if (typeof definition.readOnly !== "boolean") {
    throw new Error(`Extension tool ${definition.name} requires readOnly metadata.`);
  }
  if (!(["none", "workspace", "external"] as unknown[]).includes(definition.effect)) {
    throw new Error(`Extension tool ${definition.name} has an invalid effect.`);
  }
}

function snapshotContextContributor(
  extensionId: string,
  input: RunnerExtensionContextContributor,
): RunnerExtensionContextContributor {
  if (typeof input !== "object" || input === null) {
    throw new Error(`Extension ${extensionId} returned an invalid context contributor.`);
  }
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(input.id)) {
    throw new Error(`Extension context contributor id ${String(input.id)} is invalid.`);
  }
  if (
    typeof input.kind !== "string" ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.kind)
  ) {
    throw new Error(`Extension context contributor ${input.id} has an invalid kind.`);
  }
  if (!Number.isSafeInteger(input.priority) || input.priority < -1_000 || input.priority > 1_000) {
    throw new Error(`Extension context contributor ${input.id} has invalid priority.`);
  }
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    input.maxBytes > RUNNER_EXTENSION_CONTEXT_MAX_BYTES
  ) {
    throw new Error(
      `Extension context contributor ${input.id} exceeds the context byte limit.`,
    );
  }
  if (typeof input.contribute !== "function") {
    throw new Error(`Extension context contributor ${input.id} requires a handler.`);
  }
  return Object.freeze({
    id: input.id,
    kind: input.kind,
    priority: input.priority,
    maxBytes: input.maxBytes,
    contribute: input.contribute.bind(input),
  });
}

function snapshotLanguageProvider(
  extensionId: string,
  input: LanguageIntelligenceProvider,
): RegisteredLanguageProvider {
  if (typeof input !== "object" || input === null) {
    throw new Error(`Extension ${extensionId} returned an invalid language provider.`);
  }
  const descriptor = parseLanguageProviderDescriptor(input.descriptor);
  for (const method of [
    "workspaceSymbols",
    "definition",
    "references",
    "diagnostics",
    "close",
  ] as const) {
    if (typeof input[method] !== "function") {
      throw new Error(`Language provider ${descriptor.id} requires ${method}.`);
    }
  }
  const provider: LanguageIntelligenceProvider = Object.freeze({
    descriptor: Object.freeze(cloneLanguageDescriptor(descriptor)),
    workspaceSymbols: input.workspaceSymbols.bind(input),
    definition: input.definition.bind(input),
    references: input.references.bind(input),
    diagnostics: input.diagnostics.bind(input),
    close: input.close.bind(input),
  });
  return { extensionId, descriptor, provider };
}

function cloneManifest(manifest: RunnerExtensionManifest): RunnerExtensionManifest {
  return {
    ...manifest,
    capabilities: [...manifest.capabilities],
  };
}

function cloneLanguageDescriptor(
  descriptor: LanguageProviderDescriptor,
): LanguageProviderDescriptor {
  return {
    ...descriptor,
    extensions: [...descriptor.extensions],
    rootMarkers: [...descriptor.rootMarkers],
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
