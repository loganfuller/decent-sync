---
title: On a local network
description: Running the server where only your own network reaches it.
---

The server can run on a computer on the same network as the machines, with no
public host name or certificate:

1. Give the computer a fixed address, such as with a DHCP reservation in your
   router.
2. Set `PUBLIC_URL` to that address with `http://`, such as
   `PUBLIC_URL=http://192.168.1.20:3000`.

The plugin connects to an `http://` server over plain `ws://`, and to an
`https://` one over `wss://`.

Over plain `http://`, all traffic is unencrypted, each Machine's token
included, so do this only on a network you trust. To reach the server from
outside the network, put it behind HTTPS instead.
