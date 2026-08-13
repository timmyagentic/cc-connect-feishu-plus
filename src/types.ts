export type AgentType = "codex" | "claudecode";

export interface FeishuPlatformConfig {
  type: "feishu" | "lark";
  appId: string;
  appSecret: string;
  baseUrl: string;
}

export interface ReferenceDisplayConfig {
  normalizeAgents: string[];
  renderPlatforms: string[];
  displayPath: string;
  markerStyle: string;
  enclosureStyle: string;
}

export interface ProjectRuntimeConfig {
  name: string;
  agentType: AgentType;
  agentCommand: string;
  backend: string;
  workDir?: string;
  appendSystemPrompt?: string;
  references?: ReferenceDisplayConfig;
  feishu: FeishuPlatformConfig;
}

export type ActivityPhase =
  | "analyzing"
  | "working"
  | "verifying"
  | "preparing_answer";

export interface ActivityProgress {
  reasoningCount: number;
  toolCount: number;
}

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
  progress?: ActivityProgress;
  streamingStarted?: boolean;
  draftMarkdown?: string;
  startedAt: string;
}

export interface InstalledProject {
  name: string;
  agentType: "codex";
  originalAgentCommand: string;
  proxyAgentCommand: string;
}

export interface InstallManifest {
  version: 2;
  packageVersion: string;
  installedAt: string;
  configPath: string;
  backupPath: string;
  configBeforeSha256: string;
  configAfterSha256: string;
  ccBinaryPath?: string;
  ccBinarySha256?: string;
  nodeExecutablePath: string;
  runtimeExecutablePath: string;
  runtimeExecutableSha256: string;
  projects: InstalledProject[];
}
