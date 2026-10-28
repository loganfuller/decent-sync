import net from "node:net";

/**
 * A TCP proxy to a server that leaves its next `stall` connections
 * unanswered, as a server that accepts connections but never completes the
 * WebSocket upgrade does, and passes the rest through.
 */
export async function startStallingProxy(serverUrl: string, stall: number) {
  const target = new URL(serverUrl);
  let toStall = stall;
  const stalled: net.Socket[] = [];
  const passed: net.Socket[] = [];
  const proxy = net.createServer((socket) => {
    if (toStall > 0) {
      toStall--;
      stalled.push(socket);
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname);
    passed.push(socket, upstream);
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stalled,
    stallNext(count: number) {
      toStall = count;
    },
    async close() {
      for (const socket of [...stalled, ...passed]) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
}
