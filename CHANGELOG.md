# Changelog

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
