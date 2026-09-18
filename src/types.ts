// Minimal shape of Pi's extension hook contract, covering only what this
// extension touches. Pi's real types are richer; we deliberately keep this
// narrow rather than depending on the host package.

export interface ToolCallEventLike {
  toolName?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
}

export interface ExtensionContextLike {
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
    setStatus?: (key: string, value: string | undefined) => void;
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
