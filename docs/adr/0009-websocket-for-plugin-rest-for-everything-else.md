# One WebSocket for the plugin, REST for everything else

All traffic between the plugin and the server goes over one WebSocket, in both directions. Everything else uses the server's REST API, which is the public API of ADR-0002: the management interface, CSV import, the tablet's location view and the Roux private repo.

We considered REST from the plugin too. Decaid documents restrictions on plugin `fetch` reaching private IPs, so relying on that channel would put LAN self-hosting at risk. Decaid's WebSocket transport supports LAN connections and gives the server a channel to push library changes to tablets. Its pending outbound limit is 1 MiB per transport, so oversized messages need chunking and flow control.

## Host evidence clarification (2026-10-03)

The earlier rationale stated that Decaid blocks private-IP `fetch` as an unconditional fact. This conflicts with `PluginManager._performFetch` in Decaid v0.8.6, v0.8.7 and local checkout `a45961b3`, which passes the URL to `HttpClient.openUrl` without a private-address check. The milestone 1 spec's Further Notes originally repeated that stronger claim and was corrected in the issue audit. Treat the restriction as documented host policy, not a verified enforcement guarantee. The WebSocket decision remains unchanged; use plugin `fetch` for Decaid's local API and the transport for server traffic. See `../AI_RUNTIME_NOTES.md` for source pointers.
