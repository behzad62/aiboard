import type { NativeToolCall } from "./base";

export type ClientExecutionEnvironmentKind = "browser" | "desktop" | "mobile";

export interface ClientExecutionScreenshot {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  width?: number;
  height?: number;
}

export interface ClientExecutionAction {
  name: string;
  arguments: Record<string, unknown>;
  intent?: string;
}

export interface ClientExecutionHandoff {
  capabilityId: "computer_use" | "browser_use";
  environment: ClientExecutionEnvironmentKind;
  action: ClientExecutionAction;
  requiresNextScreenshot: boolean;
}

export interface ClientExecutionToolCall extends NativeToolCall {
  clientExecution: ClientExecutionHandoff;
}

export interface ClientExecutionRequest {
  executionId: string;
  capabilityId: ClientExecutionHandoff["capabilityId"];
  environment: ClientExecutionEnvironmentKind;
  action: ClientExecutionAction;
  screenshot?: ClientExecutionScreenshot;
}

export interface ClientExecutionResult {
  executionId: string;
  ok: boolean;
  output?: Record<string, unknown> | string;
  error?: string;
  nextScreenshot?: ClientExecutionScreenshot;
}

export interface ClientExecutionExecutor {
  readonly environments: readonly ClientExecutionEnvironmentKind[];
  execute(request: ClientExecutionRequest): Promise<ClientExecutionResult>;
  captureScreenshot?(
    environment: ClientExecutionEnvironmentKind,
  ): Promise<ClientExecutionScreenshot>;
}
