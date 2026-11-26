---
title: Quick start
description: "From nothing to a Machine online: start the server, create the first Admin account, add a Machine."
---

You need Docker on a computer your machines' tablets can reach. Give it a
fixed address on your network, such as with a DHCP reservation in your router.

1. Download the Compose file, set the address people and tablets will use,
   and start the server and PostgreSQL:

   ```bash
   curl -O https://raw.githubusercontent.com/loganfuller/decent-sync/main/docker-compose.yml
   echo 'PUBLIC_URL=http://192.168.1.20:3000' > .env
   docker compose up -d
   ```

2. Open `PUBLIC_URL` in a browser and create the first Admin account. Do this
   straight away: until you do, anyone who can reach the server can.
3. Under **Locations**, add one for each site. A Machine shares the Library
   and Recipes only while it is at a Location.
4. Under **Machines**, add each machine at its Location. Copy the server URL
   and Token it shows. The Token is shown only once.
   [Locations and Machines](../../get-started/locations-and-machines/) says
   more about both steps.
5. [Install the plugin](../../get-started/install-the-plugin/) on each
   machine's tablet, enter the server URL and Token in its settings, and load
   it.

The Machine then shows as online in the management interface. To bring in
other people, see [Invite people](../../get-started/invite-people/).

## Before you rely on it

Over plain `http://`, traffic is unencrypted, each Machine's Token included.
Use it only on a network you trust
([On a local network](../../self-hosting/local-network/)). To reach the server
from elsewhere, see [On the internet](../../self-hosting/internet/) or
[fly.io](../../self-hosting/fly-io/).
[Docker Compose](../../self-hosting/docker-compose/) and
[Configuration](../../self-hosting/configuration/) cover every setting.

:::caution[Upgrade the server soon after each release]
Tablets install each new plugin release within 12 hours, unless it asks for
a new permission, and a plugin two releases ahead of its server may not work
with it. Upgrade the server soon after each release:
`docker compose pull && docker compose up -d`
([Upgrading](../../self-hosting/upgrading/)).
:::
