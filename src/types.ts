// Minimal shape of Pi's extension hook contract, covering only what this
// extension touches. Pi's real types are richer; we deliberately keep this
// narrow rather than depending on the host package.

export interface ToolCallEventLike {
  toolName?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
}

export interface AuthResolution {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  error?: string;
}

export interface ExtensionContextLike {
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    input?: (title: string, placeholder?: string) => Promise<string | undefined>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, value: string | undefined) => void;
  };
  // The active session model, and the registry used to resolve/authenticate
  // a different one - both used only by the optional LLM-escalation path
  // (src/llm-escalation.ts), never required for the core Jev gate.
  model?: unknown;
  modelRegistry?: {
    find?: (provider: string, id: string) => unknown;
    getApiKeyAndHeaders?: (model: unknown) => Promise<AuthResolution>;
  };
}

export type ToolCallDecision = Record<string, never> | { block: true; reason: string };

export type ExtensionAPI = {
  on(event: string, handler: (...args: any[]) => any): void;
  registerCommand?: (
    name: string,
    definition: {
      description: string;
      handler: (args: string, ctx: ExtensionContextLike) => Promise<void> | void;
    },
  ) => void;
};
