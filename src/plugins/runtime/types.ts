export interface RuntimeLog {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface RuntimeDeps {
  mercuryVersion: string;
  dataDir: string;
  /** Resolved settings (defaults filled in, unknown keys dropped). */
  settings: Record<string, unknown>;
  /** Only the secrets the manifest declared, read from ~/.mercury/.env. */
  secrets: Record<string, string | undefined>;
  log: RuntimeLog;
  /** A failure outside a tool call (timer, crash, protocol error). Counts toward the circuit breaker. */
  onError(message: string): void;
  /** The runtime gave up (e.g. crashed too often). The manager disables the plugin. */
  onFatal?(code: 'crashed' | 'activation', message: string): void;
}

export interface PluginRuntime {
  readonly kind: 'in-process' | 'out-of-process';
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}
