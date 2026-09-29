# Running WiserHeat Control Panel as a Linux service

Run the panel on a Raspberry Pi or other Linux machine without Docker. It starts by itself whenever the machine boots, restarts if anything goes wrong, and can be opened from any phone, tablet or computer in the house.

Prefer Docker? See the [Docker guide](DOCKER.md). Running Home Assistant? Use the [Home Assistant app](../README.md#install-on-home-assistant) instead.

**What you need**

- A Linux machine that's always on, on the same home network as your Wiser hub. For example, a Raspberry Pi running Raspberry Pi OS, or a Debian or Ubuntu server.
- systemd, which almost every current Linux uses.
- Node.js 18 or newer. The installer adds it for you on Debian, Ubuntu and Raspberry Pi OS if it's missing.

## Install

Run this one command on the machine:

```
curl -fsSL https://raw.githubusercontent.com/BayMax1990/WiserHeat-ControlPanel/main/linux/install.sh | sudo bash
```

Or, from a downloaded copy of this repository:

```
sudo ./linux/install.sh
```

The installer:

1. installs Node.js if it's missing;
2. creates a `wiserheat` user for the panel to run as;
3. puts the panel in `/opt/wiserheat-panel`;
4. sets it up as the `wiserheat-panel` service, and starts it.

When it's done, it prints the address to open, such as `http://192.168.1.20:8765`.

**The first visit.** The first person to open the panel is asked to create a password. Every device then signs in with it, and stays signed in for 30 days. After that, a short setup screen asks for your hub's address and secret.

To set the password during installation instead, so nobody else can create it first:

```
sudo ./linux/install.sh --password "choose-a-password"
```

## Options

| Option | What it does |
|---|---|
| `--port <number>` | Listen on another port instead of 8765. |
| `--password <password>` | Set the sign-in password now. It then can't be changed from the panel's Settings. |
| `--version <tag>` | With the one-line install: install a particular release, such as `v1.0.0`, or `main`. It installs the latest release by default. |
| `--uninstall` | Remove the service and the panel. Keeps your settings and data. |
| `--purge` | With `--uninstall`: also delete your settings, data and the `wiserheat` user. |

With the one-line install, pass options after `bash -s --`, for example:

```
curl -fsSL https://raw.githubusercontent.com/BayMax1990/WiserHeat-ControlPanel/main/linux/install.sh | sudo bash -s -- --port 8080
```

You can also change the options later, in `/etc/wiserheat-panel.env`. Then restart the panel with `sudo systemctl restart wiserheat-panel`.

## Updating

Run the installer again, the same way as before. It replaces the panel with the latest release and keeps your settings, data and options.

## Where things are

| Path | What's in it |
|---|---|
| `/opt/wiserheat-panel` | The panel itself |
| `/var/lib/wiserheat-panel` | Your settings (including the hub secret), history, room layout and schedule backups. Only the `wiserheat` user can read it. |
| `/etc/wiserheat-panel.env` | Options: port and password. Only root can read it. |
| `/etc/systemd/system/wiserheat-panel.service` | The service definition |

To back up the panel, copy `/var/lib/wiserheat-panel`.

## Everyday commands

| To… | Run |
|---|---|
| See if it's running | `systemctl status wiserheat-panel` |
| See its log | `journalctl -u wiserheat-panel` (add `-f` to follow it live) |
| Restart it | `sudo systemctl restart wiserheat-panel` |
| Stop it | `sudo systemctl stop wiserheat-panel` |
| Stop it starting at boot | `sudo systemctl disable wiserheat-panel` |

## Security

The panel runs as its own `wiserheat` user, with no special privileges. The service locks it down so it can only read its own files, write its own data folder and use the network. systemd rates it as "OK", scoring 1.3 on `systemd-analyze security`, where lower is safer.

**Don't forward a port on your router to it.** To use the panel away from home, use a VPN such as [Tailscale](https://tailscale.com) or WireGuard.

## Troubleshooting

**Other devices can't open it.** If the machine has a firewall, let the panel's port through. With `ufw`, for example, run `sudo ufw allow 8765/tcp`. The installer warns you if `ufw` is on.

**"Node.js is too old".** Older Raspberry Pi OS and Debian versions come with an old Node.js. Install a newer one from [NodeSource](https://github.com/nodesource/distributions), then run the installer again.

**"Node.js is installed in a home folder".** A Node.js installed with a tool like nvm lives in your home folder, which the service isn't allowed to read. Install Node.js for the whole system, with `apt` or from NodeSource, then run the installer again.

**It won't start.** Run `journalctl -u wiserheat-panel -n 50` to see why.

**Forgotten password.** Remove the saved password, then restart. The next visit asks for a new one:

```
sudo -u wiserheat node -e "const f='/var/lib/wiserheat-panel/config.json',c=require(f);delete c.passwordHash;require('fs').writeFileSync(f,JSON.stringify(c,null,2))"
sudo systemctl restart wiserheat-panel
```

If you set the password with `--password`, change it in `/etc/wiserheat-panel.env` instead.

## Uninstalling

```
sudo ./linux/install.sh --uninstall
```

That keeps your settings and data, in case you reinstall. Add `--purge` to delete those too. With the one-line install, use `| sudo bash -s -- --uninstall`.
