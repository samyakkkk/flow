// @effect-diagnostics nodeBuiltinImport:off - the bundled-client fallback runs
// inside Electron's protocol handler, a plain promise callback outside this
// process's Effect runtime, and must read through Node's fs so asar archives
// resolve transparently.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

export const DESKTOP_HOST = "app";
export const DESKTOP_PRODUCTION_SCHEME = "flow";
export const DESKTOP_DEVELOPMENT_SCHEME = "flow-dev";

export function getDesktopScheme(isDevelopment: boolean): string {
  return isDevelopment ? DESKTOP_DEVELOPMENT_SCHEME : DESKTOP_PRODUCTION_SCHEME;
}

export function getDesktopOrigin(isDevelopment: boolean): string {
  return `${getDesktopScheme(isDevelopment)}://${DESKTOP_HOST}`;
}

export function getDesktopUrl(isDevelopment: boolean): string {
  return `${getDesktopOrigin(isDevelopment)}/`;
}

export class ElectronProtocolRegistrationError extends Schema.TaggedErrorClass<ElectronProtocolRegistrationError>()(
  "ElectronProtocolRegistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register Electron protocol scheme "${this.scheme}".`;
  }
}

export class ElectronProtocolUnregistrationError extends Schema.TaggedErrorClass<ElectronProtocolUnregistrationError>()(
  "ElectronProtocolUnregistrationError",
  {
    scheme: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to unregister Electron protocol scheme "${this.scheme}".`;
  }
}

// The renderer's origin is stable (`flow://app`) but the server behind it is
// not: the primary instance is the Flow service the app attached to, and its
// address is only known once the attach succeeds (and changes if the service
// moves). So the target is resolved per request rather than captured at
// registration — see `resolveTarget`.
export interface DesktopProtocolRegistrationInput extends DesktopContentSecurityPolicyInput {
  // None means "no server to talk to right now" (attach failed, or has not
  // completed yet). Requests then fall back to the bundled client so the
  // recovery screen can render without a server.
  readonly resolveTarget: () => Effect.Effect<Option.Option<URL>>;
  // Directory holding the built web client that ships inside the desktop
  // artifact (`<serverRoot>/apps/server/dist/client`). Read through Node's
  // fs, which sees inside an asar archive transparently in the main process.
  readonly bundledClientDir: string;
}

export interface DesktopContentSecurityPolicyInput {
  readonly scheme: string;
  readonly clerkFrontendApiHostname: string | undefined;
}

export class ElectronProtocol extends Context.Service<
  ElectronProtocol,
  {
    readonly registerDesktopProtocol: (
      input: DesktopProtocolRegistrationInput,
    ) => Effect.Effect<void, ElectronProtocolRegistrationError, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronProtocol") {}

export function makeDesktopContentSecurityPolicy(input: DesktopContentSecurityPolicyInput): string {
  const clerkOrigin = input.clerkFrontendApiHostname
    ? `https://${input.clerkFrontendApiHostname}`
    : undefined;
  const scriptSources = [
    "'self'",
    "'unsafe-inline'",
    "'wasm-unsafe-eval'",
    ...(clerkOrigin ? [clerkOrigin] : []),
    "https://challenges.cloudflare.com",
  ];

  // The renderer connects directly to user-configured environments in addition to
  // the build-configured Clerk, relay, and OTLP endpoints. Those environment
  // origins are not known when this response policy is created, so restrict
  // connections by the network schemes the client supports instead of by host.
  const connectSources = ["'self'", "http:", "https:", "ws:", "wss:"];

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `img-src 'self' ${input.scheme}: blob: data: http: https:`,
    `media-src 'self' ${input.scheme}: blob: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${input.scheme}: data:`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com",
    "form-action 'self'",
  ].join("; ");
}

function withContentSecurityPolicy(response: Response, policy: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Must run synchronously during process bootstrap, before Electron emits `ready`.
 */
export function registerDesktopSchemePrivilegesSync(): void {
  Electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DESKTOP_PRODUCTION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
    {
      scheme: DESKTOP_DEVELOPMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

const registerDesktopSchemePrivileges = Effect.sync(registerDesktopSchemePrivilegesSync).pipe(
  Effect.withSpan("desktop.electron.protocol.registerSchemePrivileges"),
);

export const layerSchemePrivileges = Layer.effectDiscard(registerDesktopSchemePrivileges);

/**
 * Entry point for every `flow://app` request. Resolves the current server on
 * each request and proxies to it, or serves the bundled client when there is
 * no server to reach.
 */
async function handleDesktopRequest(
  request: Request,
  input: DesktopProtocolRegistrationInput,
  contentSecurityPolicy: string,
): Promise<Response> {
  const requestUrl = new URL(request.url);
  if (requestUrl.host !== DESKTOP_HOST) {
    return new Response(null, { status: 404 });
  }

  const target = await resolveTargetSafely(input);
  return Option.isSome(target)
    ? proxyRequest(request, requestUrl, target.value, contentSecurityPolicy)
    : serveBundledClient(request, requestUrl, input.bundledClientDir, contentSecurityPolicy);
}

async function resolveTargetSafely(
  input: DesktopProtocolRegistrationInput,
): Promise<Option.Option<URL>> {
  try {
    return await Effect.runPromise(input.resolveTarget());
  } catch {
    // A resolver that dies is the same signal as "no server right now": fall
    // back to the bundled client rather than failing the navigation.
    return Option.none();
  }
}

async function proxyRequest(
  request: Request,
  requestUrl: URL,
  targetOrigin: URL,
  contentSecurityPolicy: string,
): Promise<Response> {
  const targetUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, targetOrigin);
  const headers = new Headers(request.headers);
  const headersToRemove: string[] = [];
  for (const name of headers.keys()) {
    if (
      name === "host" ||
      name === "origin" ||
      name === "referer" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding" ||
      name === "upgrade-insecure-requests" ||
      name.startsWith("sec-fetch-")
    ) {
      headersToRemove.push(name);
    }
  }
  for (const name of headersToRemove) {
    headers.delete(name);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  const response =
    request.method === "GET" || request.method === "HEAD"
      ? await fetchWithTransientRetry(targetUrl.toString(), init)
      : await Electron.net.fetch(targetUrl.toString(), init);
  return withContentSecurityPolicy(response, contentSecurityPolicy);
}

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [0, 50, 150] as const;

async function fetchWithTransientRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (const delayMs of TRANSIENT_FETCH_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await NodeTimersPromises.setTimeout(delayMs);
    }

    try {
      return await Electron.net.fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

// Paths that only a server can answer. With no server attached they must fail
// as a server failure — handing the SPA shell to a fetch() for /api/... would
// turn a missing backend into an HTML parse error somewhere far away.
const SERVER_ONLY_PATH_PREFIXES = ["/api", "/ws", "/oauth", "/.well-known"] as const;

const BUNDLED_CLIENT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function isServerOnlyPath(pathname: string): boolean {
  return SERVER_ONLY_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function bundledContentType(filePath: string): string {
  return (
    BUNDLED_CLIENT_CONTENT_TYPES[NodePath.extname(filePath).toLowerCase()] ??
    "application/octet-stream"
  );
}

/** A navigation wants the SPA shell; an asset request wants its exact file. */
function wantsDocument(request: Request, pathname: string): boolean {
  if (request.headers.get("sec-fetch-mode") === "navigate") return true;
  if ((request.headers.get("accept") ?? "").includes("text/html")) return true;
  return NodePath.extname(pathname) === "";
}

function serviceUnavailable(detail: string, contentSecurityPolicy: string): Response {
  return withContentSecurityPolicy(
    new Response(JSON.stringify({ error: "flow-service-unavailable", detail }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    contentSecurityPolicy,
  );
}

/**
 * Serve the web client that ships inside the desktop artifact. This is what
 * keeps the window renderable — recovery screen included — when the Flow
 * service is unreachable and there is nothing to proxy to.
 */
async function serveBundledClient(
  request: Request,
  requestUrl: URL,
  bundledClientDir: string,
  contentSecurityPolicy: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return serviceUnavailable("The Flow service is not reachable.", contentSecurityPolicy);
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return withContentSecurityPolicy(new Response(null, { status: 400 }), contentSecurityPolicy);
  }

  if (isServerOnlyPath(pathname)) {
    return serviceUnavailable("The Flow service is not reachable.", contentSecurityPolicy);
  }

  const clientDir = NodePath.resolve(bundledClientDir);
  const candidate = NodePath.resolve(clientDir, `.${pathname}`);
  // `..` segments resolve out of the client directory; refuse rather than
  // reading whatever they landed on.
  if (candidate !== clientDir && !candidate.startsWith(clientDir + NodePath.sep)) {
    return withContentSecurityPolicy(new Response(null, { status: 403 }), contentSecurityPolicy);
  }

  const file = candidate === clientDir ? undefined : await readFileOrUndefined(candidate);
  if (file !== undefined) {
    return bundledResponse(request, file, bundledContentType(candidate), contentSecurityPolicy);
  }

  if (!wantsDocument(request, pathname)) {
    return withContentSecurityPolicy(new Response(null, { status: 404 }), contentSecurityPolicy);
  }

  // Unknown routes are the client router's business, so they all get the shell.
  const indexHtml = await readFileOrUndefined(NodePath.join(clientDir, "index.html"));
  if (indexHtml === undefined) {
    return serviceUnavailable(
      "The Flow service is not reachable and this build has no bundled client to fall back to.",
      contentSecurityPolicy,
    );
  }
  return bundledResponse(request, indexHtml, "text/html; charset=utf-8", contentSecurityPolicy);
}

function bundledResponse(
  request: Request,
  body: Uint8Array,
  contentType: string,
  contentSecurityPolicy: string,
): Response {
  return withContentSecurityPolicy(
    new Response(request.method === "HEAD" ? null : (body as BodyInit), {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "no-cache",
      },
    }),
    contentSecurityPolicy,
  );
}

async function readFileOrUndefined(filePath: string): Promise<Uint8Array | undefined> {
  try {
    const stats = await NodeFSP.stat(filePath);
    if (!stats.isFile()) return undefined;
    return await NodeFSP.readFile(filePath);
  } catch {
    return undefined;
  }
}

export const make = Effect.gen(function* () {
  const registered = yield* Ref.make(false);

  const registerDesktopProtocol = Effect.fn("desktop.electron.protocol.registerDesktopProtocol")(
    function* (input: DesktopProtocolRegistrationInput) {
      if (yield* Ref.get(registered)) return;

      const contentSecurityPolicy = makeDesktopContentSecurityPolicy(input);

      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            Electron.protocol.handle(input.scheme, (request) =>
              handleDesktopRequest(request, input, contentSecurityPolicy),
            );
          },
          catch: (cause) => new ElectronProtocolRegistrationError({ scheme: input.scheme, cause }),
        }).pipe(Effect.andThen(Ref.set(registered, true))),
        () =>
          Effect.try({
            try: () => Electron.protocol.unhandle(input.scheme),
            catch: (cause) =>
              new ElectronProtocolUnregistrationError({
                scheme: input.scheme,
                cause,
              }),
          }).pipe(Effect.andThen(Ref.set(registered, false)), Effect.orDie),
      );
    },
  );

  return ElectronProtocol.of({ registerDesktopProtocol });
});

export const layer = Layer.effect(ElectronProtocol, make);
