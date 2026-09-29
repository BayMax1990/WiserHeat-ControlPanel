# Running WiserHeat Control Panel with Docker

Run the panel on a home server, NAS or Raspberry Pi, and open it from any phone, tablet or computer in the house.

**What you need**

- Docker on a machine that's always on, on the same home network as your Wiser hub.
- A PC-type processor (amd64) or a 64-bit ARM board such as a Raspberry Pi 4 or 5 running a **64-bit** operating system. 32-bit Raspberry Pi OS isn't supported.

The image is `ghcr.io/baymax1990/wiserheat-panel`.

## Quick start

```
docker run -d --name wiserheat-panel --restart unless-stopped \
  -p 8765:8765 -v wiserheat-data:/data \
  ghcr.io/baymax1990/wiserheat-panel:latest
```

Then open `http://<your server's address>:8765`, for example `http://192.168.1.20:8765`.

## With Docker Compose

Save this as `docker-compose.yml`. It's also in this repository.

```yaml
services:
  wiserheat:
    image: ghcr.io/baymax1990/wiserheat-panel:latest
    container_name: wiserheat-panel
    restart: unless-stopped
    ports:
      - "8765:8765"
    volumes:
      - wiserheat-data:/data

volumes:
  wiserheat-data:
```

Then run `docker compose up -d`.

## The first visit

1. **Create a password.** The panel can be reached from other devices, so the first person to open it is asked to create one. Every device then signs in with it, and stays signed in for 30 days. To set it before anyone visits, see `PANEL_PASSWORD` below.
2. **Connect to your hub.** A short setup screen asks for your hub's address and secret, and explains how to find both. Its **Find my hub** button can't search your network from inside Docker's usual network, so type the address. With host networking (see *Troubleshooting*), Find my hub works.

## Settings

| Environment variable | What it does |
|---|---|
| `PANEL_PASSWORD` | Sets the sign-in password when the container starts, so nobody else can create it first. Leave it out to choose a password on the first visit and change it later in Settings. |

To use a different port, change the left-hand number in the port mapping. For example, `-p 8080:8765` opens the panel on port 8080. The panel always listens on 8765 inside the container.

Everything else, such as the panel's name, the hub's address and secret, and room icons, is set in the panel under the cog.

## Your data

The panel keeps everything in `/data` inside the container:

| File | What's in it |
|---|---|
| `config.json` | Settings, including the hub secret and the stored password hash. Keep this private. |
| `layout.json` | Room order and groups |
| `history.json` | Recorded temperatures, for the graphs and boiler statistics |
| `backups/` | A copy of every schedule, saved before each change |

The examples above keep this in a Docker volume called `wiserheat-data`, which survives updates. To keep it in a folder you choose instead, for example so your NAS backs it up, replace the volume with a folder:

```
-v /volume1/docker/wiserheat:/data
```

**Folder permissions.** The panel runs as user 1000, not as root. If it can't save to your folder, the log says so. Either give the folder to user 1000:

```
sudo chown -R 1000:1000 /volume1/docker/wiserheat
```

or run the container as the folder's owner, for example `--user 99:100` on Unraid (`user: "99:100"` in Compose).

## Updating

With Compose:

```
docker compose pull
docker compose up -d
```

With `docker run`, pull the new image, then remove the old container and run the same `docker run` command again. Your data stays in the volume or folder:

```
docker pull ghcr.io/baymax1990/wiserheat-panel:latest
docker rm -f wiserheat-panel
docker run -d --name wiserheat-panel ... (as before)
```

To stay on one version instead of `latest`, use a version tag such as `:1.0.0`, or `:1.0` to get fixes to 1.0 only. Every release is listed on the project's GitHub page.

## NAS and home server guides

### Synology (Container Manager)

1. In **Container Manager → Registry**, click **Settings → Add** and add `https://ghcr.io` if it isn't listed. Or skip the registry, and use **Project** with the Compose file above, which is often easier.
2. For a project: **Project → Create**, choose a folder such as `/docker/wiserheat`, and paste the Compose file. If you use a folder for data instead of the volume, create it in File Station first.
3. Start the project, then open `http://<your NAS's address>:8765`.

If the log says it can't save to the data folder, see *Folder permissions* above.

### Unraid

1. **Docker → Add Container.**
2. **Repository:** `ghcr.io/baymax1990/wiserheat-panel:latest`
3. **Port:** add a port mapping, container port `8765`, host port `8765`.
4. **Path:** add a path, container path `/data`, host path `/mnt/user/appdata/wiserheat`.
5. **Extra Parameters:** `--user 99:100`, so it can save to Unraid's appdata share.
6. Apply, then open `http://<your Unraid server's address>:8765`.

### Portainer

**Stacks → Add stack**, paste the Compose file above, then **Deploy the stack**.

### Raspberry Pi

Install Docker (for example with `curl -fsSL https://get.docker.com | sh`), then use the quick start above. The image works on 64-bit Raspberry Pi OS.

## Using it away from home

**Don't forward a port on your router to the panel.** To reach it from outside, use a VPN such as [Tailscale](https://tailscale.com) or WireGuard. Your phone then joins your home network securely, and the panel works as if you were at home.

If you put the panel behind your own reverse proxy (nginx, Caddy, Traefik and so on):

- pass the original `Host` header through, which most proxies do by default;
- serve it over HTTPS and set `X-Forwarded-Proto: https`, so the sign-in cookie is only sent over HTTPS.

## Troubleshooting

**The container stops at once, saying it can't save to the data folder.** See *Folder permissions* above.

**The panel can't reach the hub.** The machine running Docker must be able to reach the hub's address. Check with `ping <hub address>` on that machine. On some NAS setups, the container's own network can't reach the rest of your home network. In that case, add `network_mode: host` to the Compose file (or `--network host` to `docker run`) and remove the port mapping. The panel is then on port 8765 of the server itself. It can then also hear the hub's announcements, so **Find my hub** works.

**Forgotten password.** Remove the saved password, then restart. The next visit asks for a new one:

```
docker exec wiserheat-panel node -e "const f='/data/config.json',c=require(f);delete c.passwordHash;require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
docker restart wiserheat-panel
```

If you set `PANEL_PASSWORD`, change it there instead.

**Checking it's running.** `docker ps` shows the container as *healthy* once the panel answers. `docker logs wiserheat-panel` shows what it's doing.

## Building the image yourself

From a copy of this repository:

```
docker build -t wiserheat-panel .
```

Then use `wiserheat-panel` in place of `ghcr.io/baymax1990/wiserheat-panel:latest` in the examples, or `build: .` in the Compose file.
