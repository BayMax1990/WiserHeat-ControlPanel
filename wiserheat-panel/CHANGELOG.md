# Changelog

## 1.2.0 (not released yet)

- **History tab.** Any day, week, month or year the app has recorded, with room temperatures, boiler, zone and hot water hours, and electricity and cost. Turn on **Compare with last year** to see the same period a year earlier beside it.
- **Years of history.** Every reading is kept for a year, then thinned to one every half hour and kept for five years. Both can be changed under **Settings → Recording**.
- **Themes**, in Settings: Modern; Steampunk, with brass and mahogany, a pressure gauge for the boiler and turning gears; or Sci-fi, a starship bridge with a warp core and a warp starfield.
- **Open on**, in Settings: choose the page the panel opens on, or leave it opening wherever you left off.
- Recordings are kept one file per day, and only ever added to, instead of one file rewritten after every reading. Your existing history is moved over the first time the new version starts.

## 1.1.0

- **Trips.** Plan when you're away, and the app switches Away mode on as you leave and off before you're back, so the house is warm. Weekly repeats, presets and a calendar. It runs with the panel closed.
- **Hot water, heating zones, electric and underfloor heating, lights and blinds**, on systems that have them. These are new and were tested against a simulated hub, so feedback is welcome.
- Every battery device on the Batteries tab, including smoke alarms, window and door sensors, and button panels.
- On phones, the tabs move to a bar at the bottom, and the header fits narrow screens.

## 1.0.0

- **Find my hub.** The setup screen and Settings can look for your Wiser hub on your network and fill in its address, instead of you typing it.
- Installs and updates are much quicker. Home Assistant now downloads a ready-made app instead of building it on your device.
- From now on, the app's version matches the panel's releases on GitHub.

## 0.1.2

- Stops straight away when the app is stopped or updated, instead of waiting to be shut down.
- Temperature history is saved more safely, so stopping mid-save can't damage it.

## 0.1.1

- Fixed "502: Bad Gateway" when opening the panel. The app now starts where Home Assistant expects it.

## 0.1.0

- First release as a Home Assistant app.
- Opens from the Home Assistant sidebar, with sign-in handled by Home Assistant.
- A setup screen on first start asks for the hub's address and secret.
- Settings and data are included in Home Assistant backups.
