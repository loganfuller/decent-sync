import net from "node:net";

// Stands in for a proxy that routes by the server's health check, such as
// fly.io's, in front of several server instances: each connection, a tablet's
// included, goes to the first instance whose routing check, `/api/health`,
// answers 200 as it arrives, and stays with that instance until it closes.

export interface RoutingProxy {
  /** The origin to reach the instances through, for example http://127.0.0.1:41234. */
  url: string;
  /** The origin of the instance each connection went to, in the order they arrived. */
  routed: string[];
  close(): Promise<void>;
}

/** Starts a proxy in front of the instances given, preferring them in that order. */
export async function startRoutingProxy(instances: { url: string }[]): Promise<RoutingProxy> {
  const routed: string[] = [];
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const healthy = async (url: string) => {
    try {
      return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      return false;
    }
  };

  const server = net.createServer(async (client) => {
    track(client);
    // What the client sends meanwhile waits for the instance.
    client.pause();
    let target: string | undefined;
    for (const { url } of instances) {
      if (await healthy(url)) {
        target = url;
        break;
      }
    }
    if (target === undefined || client.destroyed) return void client.destroy();
    routed.push(target);
    const { hostname, port } = new URL(target);
    const upstream = net.connect({ host: hostname, port: Number(port) });
    track(upstream);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    routed,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
