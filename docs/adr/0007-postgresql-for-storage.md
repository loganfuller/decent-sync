# PostgreSQL for persistent storage

The server stores all persistent data (machines, locations, the shared library, stock movements, shots and their measurements) in PostgreSQL, replacing the prototype's JSON files. Redis may be used for non-durable work such as caching, queues or presence, but never as the only copy of anything. PostgreSQL is easy to self-host and widely offered managed (including on fly.io, where Roux will run), which suits ADR-0001's one owner per server.
