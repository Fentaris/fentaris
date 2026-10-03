import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

/** A trusted HTTPS edge for the HTTP proxy, matching a production TLS terminator. */
export async function startTlsProxy() {
  const directory = await mkdtemp(path.join(tmpdir(), "fentaris-oauth-tls-"));
  const caFile = path.join(directory, "certificate.pem");
  const keyFile = path.join(directory, "key.pem");
  const previousCAs = getCACertificates("default");
  let upstream: URL | undefined;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", caFile], { stdio: "ignore" });
    const certificate = await readFile(caFile, "utf8");
    const server = createServer({ cert: certificate, key: await readFile(keyFile) }, (incoming, outgoing) => {
      if (!upstream) { outgoing.writeHead(503).end(); return; }
      const forwarded = request(new URL(incoming.url ?? "/", upstream), { method: incoming.method, headers: { ...incoming.headers, host: upstream.host } }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      forwarded.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      outgoing.on("close", () => forwarded.destroy());
      incoming.pipe(forwarded);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    setDefaultCACertificates([...previousCAs, certificate]);
    return {
      url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      caFile,
      setUpstream(url: string) { upstream = new URL(url); },
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        setDefaultCACertificates(previousCAs);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    setDefaultCACertificates(previousCAs);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
