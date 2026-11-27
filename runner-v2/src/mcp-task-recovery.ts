export interface McpTaskHandleObservation { taskId: string; createdAt: string; expiresAt: number; credentialBinding?: string }
export interface McpTaskRecoveryReceipt extends McpTaskHandleObservation {
  stdioBinding?: string;
  extensionId: string; versionId: string; generation: number; componentId: string;
  serverName: string; toolName: string; componentDigest: string; schemaDigest: string;
}
export type McpTaskReceiptRecorder = (receipt: McpTaskRecoveryReceipt) => void;
export function validMcpTaskReceipt(value: unknown): value is McpTaskRecoveryReceipt {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["extensionId","versionId","componentId","serverName","toolName","taskId"].every(k =>
    typeof v[k] === "string" && (v[k] as string).length > 0 && (v[k] as string).length <= 512) &&
    ["componentDigest","schemaDigest"].every(k => typeof v[k] === "string" && /^[a-f0-9]{64}$/.test(v[k] as string)) &&
    (v.stdioBinding===undefined || typeof v.stdioBinding==="string" && /^[a-f0-9]{64}$/.test(v.stdioBinding)) &&
    (v.credentialBinding===undefined || typeof v.credentialBinding==="string" && /^[a-f0-9]{64}$/.test(v.credentialBinding)) &&
    typeof v.createdAt==="string" && v.createdAt.length<=64 && Number.isFinite(Date.parse(v.createdAt)) &&
    Number.isSafeInteger(v.generation) && Number(v.generation)>=0 &&
    Number.isSafeInteger(v.expiresAt) && Number(v.expiresAt)>0;
}

// Private opt-in: handles and creation times persist across process launches.
export function durableStdioTasks(discovery: unknown): boolean {
  const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
  if(!obj(discovery)||!obj(discovery.capabilities)||!obj(discovery.capabilities.extensions))return false;
  const ext=discovery.capabilities.extensions["io.aiboard/durable-tasks"];
  return obj(ext)&&ext.crossProcess===true && obj(discovery.capabilities.extensions["io.modelcontextprotocol/tasks"]);
}
