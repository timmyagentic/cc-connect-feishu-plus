export type AgentType = "codex" | "claudecode";

export interface FeishuPlatformConfig {
  type: "feishu" | "lark";
  appId: string;
  appSecret: string;
  baseUrl: string;
}

export interface ProjectRuntimeConfig {
  name: string;
  agentType: AgentType;
  appendSystemPrompt?: string;
  feishu: FeishuPlatformConfig;
}

export type ActivityPhase =
  | "analyzing"
  | "working"
  | "verifying"
  | "preparing_answer";

export type CardTransport = "cardkit" | "message_patch";

export interface TurnState {
  version: 1;
  turnId: string;
  project: string;
  sessionKey: string;
  chatId: string;
  marker: string;
  messageId: string;
  cardId?: string;
  transport: CardTransport;
  sequence: number;
  phase: ActivityPhase;
  streamingStarted?: boolean;
  draftMarkdown?: string;
  startedAt: string;
}

export interface InstallManifest {
  version: 1;
  packageVersion: string;
  installedAt: string;
  configPath: string;
  backupPath: string;
  configBeforeSha256: string;
  configAfterSha256: string;
  ccBinaryPath?: string;
  ccBinarySha256?: string;
  projects: Array<{ name: string; agentType: AgentType }>;
  mcpRegistrations: Array<{ agentType: AgentType; name: string }>;
}
