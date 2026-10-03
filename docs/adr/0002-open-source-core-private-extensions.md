# Open-source core, Roux-specific work in a private repo

The plugin, the server and a generic management interface (locations, machines, the shared library, basic shot analytics) are open source and must be complete without anything Roux-specific. Roux-only work, such as custom reports, branding or links to Roux's roasting and inventory systems, lives in a private repo and uses only the server's public API. When Roux needs something the core lacks, the core grows a generic version of it. The test for what belongs in the core is whether a small multi-cafe owner elsewhere would want it.

Roux's needs take priority over open-source generality when the two genuinely conflict, but a conflict is resolved by extending the core API, not by putting Roux-specific behavior in the core.
