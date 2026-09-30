# Changelog

## 1.1.0

**Plan trips away**
- Plan trips from the Rooms tab, next to the Away switch. The panel switches Away mode on as you leave and off before you're back, so the house is warm, three hours before by default.
- Presets (*This weekend*, *Next weekend*, one or two weeks), date and time boxes, and a calendar.
- Weekly repeats, until a date or until deleted.
- A banner while you're away, with **I'm home early**; switching Away off by hand also ends the trip.
- Away time is shaded on the Schedules timeline.
- Runs on the server, so it works with the page closed. It catches up after the panel has been off, and keeps retrying if the hub can't be reached.

**Hot water, zones, lights, blinds and more** *(new: tested against a simulated hub, feedback welcome)*
- Hot water: a card on Rooms (Auto, On, Off and boost), a row on the Schedules timeline, a schedule editor, and a Diagnostics section.
- Heating zones: shown in the header and on Rooms; Diagnostics shows each zone's firing time and rooms.
- Electric heaters: power on the room's card; energy and cost in Diagnostics. Underfloor heating controllers: relays, floor limits and condensation warnings.
- Lights and blinds: a new tab, shown only when the hub has them, with controls and schedule editing (including sunrise and sunset).
- Batteries lists every battery device, including smoke alarms, window and door sensors, and button panels.
- Each of these only appears if your hub has the equipment.

**Phone app**
- Add the panel to your phone's home screen. It opens on Rooms, with long-press shortcuts to Rooms, Schedules, Boost rooms and Batteries.
- A friendly "Can't reach your heating" screen, on secure (https) addresses.
- On phones, the tabs move to a bar at the bottom, and the header fits narrow screens.
- **Settings → Add to your phone** shows the steps for your phone.

## 1.0.0

The first release. It runs on Windows, macOS and Linux, as a Home Assistant app, with Docker, or as a Linux service.

**Schedules**
- Every room's schedule on one colour-coded timeline, for one day or the whole week.
- An editor for each room and day: drag the times, type them, or copy another room's day, then apply to any days and rooms.
- Change several rooms at once: edit together, copy a week, 0.5° warmer or cooler, or 15 minutes earlier or later.
- Drag rooms into your own order, and into groups such as Upstairs and Downstairs.
- A schedule library for shared, named schedules.
- A backup before every change, with one-click restore.

**Rooms, batteries and diagnostics**
- Live temperatures, targets, humidity, modes, boosts and 24-hour graphs for every room.
- Away, Eco and Comfort switches, and smart plug control.
- Battery levels and warnings for every radiator valve and thermostat.
- Hub health, radio network, plug energy, boiler statistics and a tidy-up list.

**Setup and settings**
- A first-run setup screen, with **Find my hub** to look for the hub on your network.
- Settings for the page title, light or dark mode, room icons, electricity price, recording and the hub's own options.
- Use it from phones and other devices on your home network, protected by a password.

**Ways to run it**
- **Windows, macOS or Linux:** double-click `start.bat`, or run `node server.js`.
- **Home Assistant app:** add the repository, install, and open it from the sidebar.
- **Docker:** `ghcr.io/baymax1990/wiserheat-panel`, for PCs and 64-bit ARM (Raspberry Pi).
- **Linux service:** one command installs it to start at boot.
