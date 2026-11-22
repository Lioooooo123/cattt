import { createServer as createHttpParser } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checkServerIdentity, createServer as createTlsServer } from "node:tls";
import type { TLSSocket } from "node:tls";
import { certificateFingerprint, peerDnsName } from "../identity/peer-tls.ts";
import type { PeerIdentity } from "../identity/peer-tls.ts";

type LocalCertificate = ReturnType<PeerIdentity["current"]>;
type RemoteCertificate = { hostId: string; addressHost: string; addressPort: number; caCertificate: string; fingerprint: string };

const minVersion = "TLSv1.2" as const;
const maxHeaderSize = 16 * 1024;

async function send(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  fingerprint: string,
  dispatch: (request: Request, fingerprint: string) => Response | Promise<Response>,
) {
  const target = incoming.url ?? "";
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
    outgoing.writeHead(400).end();
    return;
  }
  const abort = new AbortController();
  outgoing.once("close", () => abort.abort());
  const method = incoming.method ?? "GET";
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
  }
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: abort.signal };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  const response = await dispatch(new Request(`https://peer.cattt${target}`, init), fingerprint);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body && method !== "HEAD") {
    // Bun and @types/node declare different ReadableStream methods for the same Web stream.
    await pipeline(Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]), outgoing);
  } else {
    await response.body?.cancel();
    outgoing.end();
  }
}

export async function listenPeerHttps(options: {
  hostname: string;
  port: number;
  identity: PeerIdentity;
  trustedRoots: () => string[];
  isApproved: (fingerprint: string) => boolean;
  dispatch: (request: Request, fingerprint: string) => Response | Promise<Response>;
  report: (error: unknown) => void;
}) {
  const authenticated = new Map<TLSSocket, string>();
  // Feed verified TLS sockets directly to the HTTP parser. Bun's HTTPS request
  // socket does not expose the client certificate.
  const parser = createHttpParser({ maxHeaderSize, requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    const fingerprint = authenticated.get(req.socket as TLSSocket);
    if (!fingerprint) {
      req.socket.destroy();
      return;
    }
    void send(req, res, fingerprint, options.dispatch).catch((error: unknown) => {
      if (!res.destroyed) {
        options.report(error);
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(500).end();
        }
      }
    });
  });
  const context = () => {
    const { cert, key } = options.identity.current();
    return { cert, key, ca: options.trustedRoots(), minVersion };
  };
  const server = createTlsServer({
    ...context(), requestCert: true, rejectUnauthorized: true, handshakeTimeout: 5000,
  }, (socket) => {
    const cert = socket.getPeerCertificate();
    const fingerprint = cert?.raw && certificateFingerprint(cert.raw);
    if (!socket.authorized || !fingerprint || !options.isApproved(fingerprint)) {
      socket.destroy();
      return;
    }
    socket.setTimeout(30_000, () => socket.destroy());
    socket.disableRenegotiation();
    socket.on("error", () => {});
    socket.once("close", () => authenticated.delete(socket));
    authenticated.set(socket, fingerprint);
    parser.emit("connection", socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      server.off("error", reject);
      server.on("error", options.report);
      resolve();
    });
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    server.close();
    throw new Error("无法确认 Peer HTTPS 监听端口");
  }

  return {
    port: bound.port,
    reload(closeAll = false) {
      server.setSecureContext(context());
      for (const [socket, fingerprint] of authenticated) {
        if (closeAll || !options.isApproved(fingerprint)) {
          socket.destroy();
        }
      }
    },
    async stop() {
      for (const socket of authenticated.keys()) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface PeerRequestOptions {
  query?: URLSearchParams | Record<string, string>;
  sha256?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}

export function requestPeerHttps(
  local: LocalCertificate,
  peer: RemoteCertificate,
  method: "GET" | "POST",
  path: string,
  options: PeerRequestOptions = {},
): Promise<Response> {
  const servername = peerDnsName(peer.hostId);
  const headers = new Headers(options.headers);
  for (const name of ["authorization", "cookie", "host", "connection", "content-length", "transfer-encoding"]) {
    headers.delete(name);
  }
  if (options.body !== undefined) {
    headers.set("content-length", String(Buffer.byteLength(options.body)));
  }
  const query = new URLSearchParams(options.query).toString();
  return new Promise((resolve, reject) => {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const outgoing = request({
      host: peer.addressHost, port: peer.addressPort, servername, path: query ? `${path}?${query}` : path, method,
      key: local.key, cert: local.cert, ca: peer.caCertificate, minVersion,
      rejectUnauthorized: true, agent: false, headers: Object.fromEntries(headers), signal,
      checkServerIdentity: (_name, cert) => checkServerIdentity(servername, cert)
        ?? (cert.raw && certificateFingerprint(cert.raw) === peer.fingerprint ? undefined : new Error("Peer TLS 指纹不符")),
    }, (incoming) => {
      const status = incoming.statusCode!;
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      }
      const hasBody = status !== 204 && status !== 205 && status !== 304;
      if (!hasBody) {
        incoming.resume();
      }
      resolve(new Response(hasBody ? Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array> : null, { status, headers }));
    });
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
}
