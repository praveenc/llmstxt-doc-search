/**
 * Simple logger that writes to stderr (stdout reserved for MCP protocol).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

/**
 * Set the minimum log level.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Get current timestamp in ISO format.
 */
function timestamp(): string {
  return new Date().toISOString();
}

/** Max depth when following `cause` / `AggregateError.errors` chains. */
const MAX_ERROR_DEPTH = 3;

/**
 * Describe an Error as `name: message`, adding `code` when present and any
 * `cause` or AggregateError sub-errors. JSON.stringify turns an Error into
 * `{}`, and Node's connection errors often carry their detail only in these
 * fields (an AggregateError from a failed connect has an empty message).
 */
function describeError(e: Error, depth = 0): string {
  let out = e.message ? `${e.name}: ${e.message}` : e.name;
  const code = (e as { code?: unknown }).code;
  if (code !== undefined && code !== null && code !== "") out += ` (code=${String(code)})`;
  if (depth >= MAX_ERROR_DEPTH) return out;
  if (e instanceof AggregateError && e.errors.length > 0) {
    out += ` [${e.errors.map((x) => formatLogArg(x, depth + 1)).join("; ")}]`;
  }
  if (e.cause !== undefined) out += ` (cause: ${formatLogArg(e.cause, depth + 1)})`;
  return out;
}

/** Render one extra log argument as readable text. */
export function formatLogArg(arg: unknown, depth = 0): string {
  if (arg instanceof Error) return describeError(arg, depth);
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Format and write log message to stderr.
 */
function log(level: LogLevel, message: string, ...args: unknown[]): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[currentLevel]) return;

  const prefix = `[${timestamp()}] [${level.toUpperCase()}]`;
  const formatted = args.length > 0 ? `${message} ${args.map((a) => formatLogArg(a)).join(" ")}` : message;
  console.error(`${prefix} ${formatted}`);
}

export const logger = {
  debug: (message: string, ...args: unknown[]) => log("debug", message, ...args),
  info: (message: string, ...args: unknown[]) => log("info", message, ...args),
  warn: (message: string, ...args: unknown[]) => log("warn", message, ...args),
  error: (message: string, ...args: unknown[]) => log("error", message, ...args),
};
