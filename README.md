# WiserHeat Control Panel

**Your whole home's heating, on one screen.**

A free control panel for Drayton Wiser heating systems. It runs on your own computer and talks straight to your Wiser hub over your home network. There's no cloud service, no account and no subscription, and nothing to install apart from Node.js.

- Every room's schedule on one colour-coded timeline, today or the whole week
- Change a whole floor at once: warmer, cooler, earlier or later
- Sort rooms into groups like Upstairs and Downstairs with drag and drop
- Battery warnings before a radiator valve goes flat
- Temperature graphs and boiler statistics that the hub doesn't keep itself
- An automatic backup before every schedule change

## Why use it?

The Wiser app is handy for a quick change from the sofa. When you want to see how the whole house is set up, or change several rooms together, a big screen makes it much easier. This panel shows every room side by side, so you can spot the room that's heating at 3 am, or line up bedtimes across the house in a few clicks.

## Highlights

### See your whole week at a glance

Every room's schedule sits on one timeline, coloured from cold blue to warm red, with a line marking the current time. Switch between a single day and the whole week. Hover over any block to see exactly when it starts and what temperature it holds.

### Edit schedules the easy way

Click any room's bar to open the editor. Drag the markers to move a change, type exact times, or step temperatures up and down. You can copy another room's day into this one. When you're done, choose which days and rooms the change applies to: *weekdays*, *weekends*, *every day*, or any mix.

Your edits are held as a draft until you press **Save to hub**. You can check everything before the heating changes.

### Change lots of rooms at once

Tick several rooms, or a whole group, and change them together:

- **Edit together** in one editor
- **Copy a week** from another room
- **0.5° warmer or cooler** across the board
- **15 minutes earlier or later** for every change

### Organise it your way

Drag rooms into the order you like, and group them under headings such as *Upstairs*, *Downstairs* or *Garage*. Groups can be dragged too, and a tick box on each one selects all its rooms. The Schedules and Rooms tabs share the same layout, so you set it up once.

### Shared schedules

Several rooms can follow one named schedule, such as *Bedrooms*. Edit it once and every room on it changes. The schedule library lets you create, duplicate, rename and delete schedules, and choose which rooms use each one.

### Never lose a schedule

Every change is backed up first, including which room follows which schedule. You can put everything back from **Backups** in a couple of clicks, and it even recreates schedules that were deleted since.

### Live control of every room

Each room card shows its current temperature and target, the humidity (in rooms with a thermostat) and how open the valve is. It also shows when the next scheduled change is.

- Switch a room between **Auto**, **Manual** and **Off**, or nudge its temperature
- **Boost** one room or the whole house by 1 to 3° for up to 3 hours
- **Away**, **Eco** and **Comfort** mode switches
- Smart plug on/off and auto/manual control

### Know before the batteries die

The Batteries tab lists every radiator valve and room thermostat, worst first. It shows an estimated charge, the voltage, the hub's own rating and the signal strength. Devices that need new batteries soon, or have stopped reporting, are flagged, and a warning also appears on the room's card.

### History the hub doesn't keep

The Wiser hub only knows what's happening right now. While the panel is running, it records temperatures in the background, so you get:

- a 24-hour temperature graph on every room card
- how long the boiler has fired, today and on each day
- which rooms call for heat the most
- how quickly each room warms up

### Look under the bonnet

The Diagnostics tab is for when something isn't right:

- **Hub health**: Wi-Fi signal, uptime and dropped connections
- **Radio network**: which smart plug relays signals for which valve
- **Plug energy**: live power use and a running cost estimate
- **Tidy-up**: unused schedules, devices not assigned to a room, and devices that have gone quiet
- **Valves**: each valve's own reading, opening and firmware, plus a button lock

### Make it yours

The cog in the top corner opens **Settings**. There you can:

- set the title shown at the top of the page, for example *The Smiths' Heating*
- choose light or dark mode, or follow your computer
- pick an icon for each room
- set your electricity price
- decide how often temperatures are recorded, and how long they're kept
- change hub settings such as the away-mode temperature, valve protection and open-window detection

## Get started

1. Install [Node.js](https://nodejs.org) version 18 or newer.
2. Download this project: **Code → Download ZIP** on GitHub, then unzip it. Or clone it with git.
3. Start it. On Windows, double-click `start.bat`. On a Mac or Linux, run `node server.js` in the project folder.
4. Open **http://localhost:8765** in your browser.

The first time it runs, the panel opens **Settings** and asks for two things:

- **Your hub's address.** This is its IP address on your home network, for example `192.168.1.50`. Your router's list of connected devices shows it, usually with a name starting with *WiserHeat*.
- **Your hub's secret.** This is a long code that lets the panel control the hub. Press the setup button on the hub once so its light flashes, and join the *WiserHeat* Wi-Fi network it creates. Then open `http://192.168.8.1/secret` in your browser and copy the text. Press the setup button again to finish.

Paste both in, press **Test connection**, then **Save connection**. The panel then opens on your schedules.

## Private and safe by design

- **Nothing leaves your home.** The panel talks only to your hub, over your own network.
- **Your secret stays put.** It's saved on your computer and never sent to the web page, not even to display it.
- **It only does what it says.** The server forwards a short, fixed list of requests to the hub and nothing else.
- **Other websites can't use it.** The server only answers its own page, opened on the same computer, so other websites in your browser can't read your heating or change your settings.
- **Mistakes can be undone.** Schedules are backed up before every change.

## Where your data is kept

| File | What's in it |
|---|---|
| `config.json` | Your settings, including the hub secret. Keep this private. |
| `data/layout.json` | Room order and groups |
| `data/history.json` | Recorded temperatures, for the graphs and boiler statistics |
| `data/backups/` | A copy of every schedule, saved before each change |

`config.json` and `data/` are listed in `.gitignore`, so they won't be committed if you fork this project.

## How it talks to the hub

`server.js` is a small local server with no dependencies. The hub doesn't accept requests from web pages directly, and handling them in the server keeps the secret out of the browser. It forwards only these calls:

| Panel action | Hub call |
|---|---|
| Read everything | `GET /data/domain/`, `GET /data/v2/schedules/` |
| Save a schedule | `PATCH /data/v2/schedules/Heating/{id}` with `{ "Monday": { "Time": [630, 900], "DegreesC": [200, 160] } }` |
| Rename a schedule | `PATCH /data/v2/schedules/Heating/{id}` with `{ "Name": "Bedrooms" }` |
| Create a schedule | `POST /data/v2/schedules/Assign` with `{ "Assignments": [], "Heating": { "Name": "Bedrooms" } }` (returns the new schedule) |
| Choose its rooms | `PATCH /data/v2/schedules/Assign` with `{ "Assignments": [roomIds], "Heating": { "id": 3, "Name": "Bedrooms" } }` (the complete list) |
| Delete a schedule | `DELETE /data/v2/schedules/Heating/{id}` |
| Room mode, temperature, boost | `PATCH /data/domain/Room/{id}` (`Mode`, `RequestOverride`) |
| Away, eco, comfort, hub settings | `PATCH /data/domain/System` |
| Smart plugs | `PATCH /data/domain/SmartPlug/{id}` |
| Valve button lock | `PATCH /data/domain/Device/{id}` |

Temperatures are in tenths of a degree (`185` is 18.5°), and `-200` means off. Times are written as HHMM numbers (`630` is 06:30).

To run it on a different port, change `port` in `config.json` or set the `PORT` environment variable.

## Good to know

This is an independent project. It isn't made, endorsed or supported by Drayton, Wiser or Schneider Electric. It uses the hub's local interface, which isn't officially documented, so a hub firmware update could change how things behave. It has been tested with hub firmware 3.18.3. Use it at your own risk.
