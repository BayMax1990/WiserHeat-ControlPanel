# WiserHeat Control Panel

A local control panel for a Drayton Wiser heating hub. It runs on your computer and talks directly to the hub on your home network. No cloud, no account.

## Running it

Double-click `start.bat`, or run:

```
node server.js
```

then open http://localhost:8765. You need Node 18 or newer. There's nothing to install.

The hub's address and secret live in `config.json` (see `config.example.json`). Keep that file private, because the secret gives full control of your heating.

## What it does

**Schedules**
- Shows every room's schedule on one timeline, coloured by temperature, with a line marking the current time.
- *One day* shows each room for a single day. *Whole week* shows all seven days for every room.
- Click any bar to edit that room and day. You can drag the markers, type times, step temperatures, or copy another room's day. Then choose which days and rooms to apply it to.
- Tick several rooms to change them together: *Edit together*, *Copy week from…*, 0.5° warmer or cooler, or 15 minutes earlier or later.
- **Schedule library** (the switch at the top of the Schedules tab) lists every saved schedule by name, with its week and the rooms that use it. Several rooms can share one schedule. From the library you can:
  - create a schedule, or duplicate an existing one;
  - rename one, or edit its times;
  - choose which rooms use it;
  - delete one, optionally moving its rooms to another schedule first.

  In the room view, each room shows its schedule's name. Click the name to switch that room to a different schedule.
- Changes to times are held as a draft until you press **Save to hub**. Creating, renaming, choosing rooms and deleting happen on the hub straight away.
- Every change first backs up all schedules, and which room uses which, to `data/backups/`. Restoring a backup from the *Backups* button also recreates any schedules deleted since then and puts rooms back on them.

**Rooms**
- Live temperature, target, humidity (rooms with a thermostat), valve demand, and the next scheduled change.
- Auto, Manual, or Off mode per room, plus a temperature stepper (in Auto it holds until the next scheduled change).
- Boost one room or all rooms by +1, +2 or +3° for 30 minutes up to 3 hours. You can cancel boosts one at a time or all at once.
- Away, Eco, and Comfort mode switches, plus smart plug on/off and auto/manual.
- A 24-hour temperature graph per room. The hub doesn't keep history, so the server records it every 2 minutes while it's running, in `data/history.json`.

**Batteries**
- Every radiator valve and room thermostat, worst first, with an estimated battery percentage, voltage, the hub's own rating, and signal strength.
- Flags devices that need batteries soon and any that have stopped reporting. Room cards also show a battery warning.
- Percentages are estimates from voltage. Valves count 2.5 V as empty and 3.0 V as full. Thermostats count 1.7 V as empty and 2.7 V as full.

**Diagnostics**
- *Hub health:* Wi-Fi signal and uptime, lifetime counts of disconnections and cloud drops, and internet and router check results.
- *Radio network:* which smart plug relays for which valve, with each device's signal strength.
- *Plug energy:* live watts, energy used, and a cost estimate at your unit price.
- *Boiler:* firing time today and per day, rooms that call for heat most, and how fast rooms warm up. These come from the panel's own recordings.
- *Tidy-up:* unused schedules, devices not assigned to a room or not reporting, and unknown relays.
- *Valves:* each device's own reading, target, valve opening, firmware, and a button-lock switch.
- *Settings:* away-mode temperature, valve protection, comfort pre-heat limit, and open-window detection per room.
- *Hub info:* firmware, time zone, and sunrise and sunset times.

The server keeps 7 days of history (`historyKeepHours` in `config.json`). Set `PORT` to run it on a different port.

## How it talks to the hub

`server.js` is a small proxy. The hub doesn't accept requests from web pages directly, and this keeps the secret out of the browser. It only forwards a fixed set of calls:

| Panel action | Hub call |
|---|---|
| Read everything | `GET /data/domain/`, `GET /data/v2/schedules/` |
| Save a schedule | `PATCH /data/v2/schedules/Heating/{id}` with `{ "Monday": { "Time": [630, 900], "DegreesC": [200, 160] } }` |
| Rename a schedule | `PATCH /data/v2/schedules/Heating/{id}` with `{ "Name": "Bedrooms" }` |
| Create a schedule | `POST /data/v2/schedules/Assign` with `{ "Assignments": [], "Heating": { "Name": "Bedrooms" } }` (returns the new schedule) |
| Choose its rooms | `PATCH /data/v2/schedules/Assign` with `{ "Assignments": [roomIds], "Heating": { "id": 3, "Name": "Bedrooms" } }` (the complete list) |
| Delete a schedule | `DELETE /data/v2/schedules/Heating/{id}` |
| Room mode, temperature, boost | `PATCH /data/domain/Room/{id}` (`Mode`, `RequestOverride`) |
| Away, eco, comfort | `PATCH /data/domain/System` |
| Smart plugs | `PATCH /data/domain/SmartPlug/{id}` |

Temperatures are in tenths of a degree (`185` is 18.5°), and `-200` means off. Times are written as HHMM numbers (`630` is 06:30).
