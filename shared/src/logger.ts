// logger.ts — Structured JSON logger shared by orchestrator and graph-gateway.

// Match Pino/Fastify's level ordering so one LOG_LEVEL setting has the same
// meaning across HTTP and application logs. `silent` intentionally sits above
// every emitted level.
const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
} as const;

type Level = keyof typeof LEVELS;
type EmittedLevel = Exclude<Level, "silent">;

type Fields = Record<string, unknown>;

function threshold(): number {
  const name = (process.env.LOG_LEVEL ?? "info") as Level;
  return LEVELS[name] ?? LEVELS.info;
}

export interface Logger {
  trace(msg: string, fields?: Fields): void;
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  fatal(msg: string, fields?: Fields): void;
  child(sub: string): Logger;
}

export function createLogger(component: string): Logger {
  function write(level: EmittedLevel, msg: string, fields?: Fields): void {
    if (LEVELS[level] < threshold()) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      component,
      msg,
      ...fields,
    };
    process.stdout.write(JSON.stringify(line) + "\n");
  }

  return {
    trace: (msg, fields) => write("trace", msg, fields),
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    fatal: (msg, fields) => write("fatal", msg, fields),
    child: (sub) => createLogger(`${component}:${sub}`),
  };
}
