# One WebSocket for the plugin, REST for everything else

All traffic between the plugin and the server goes over one WebSocket, in both directions. Everything else uses the server's REST API, which is the public API of ADR-0002: the management interface, CSV import, the tablet's location view and the Roux private repo.

We considered REST from the plugin too. Plugin `fetch` can reach public hosts such as fly.io, but Decaid blocks it from reaching private IPs, so an open-source user self-hosting on their LAN couldn't sync. Decaid's WebSocket transport has no such restriction, and it gives the server a channel to push library changes to tablets. Its cost is a 1 MiB outbound limit per transport, so shots too large for one frame are sent in chunks.
