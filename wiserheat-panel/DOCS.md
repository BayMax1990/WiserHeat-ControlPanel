# WiserHeat Control Panel

See and control your whole home's Drayton Wiser heating on one screen:

- every room's schedule on one colour-coded timeline, for today or the whole week;
- change several rooms at once, and sort them into groups such as Upstairs and Downstairs;
- boost rooms, switch modes, and control smart plugs;
- battery warnings before a radiator valve goes flat;
- temperature graphs and boiler statistics that the hub doesn't keep itself.

## Getting started

1. Start the app, then open **WiserHeat** in the Home Assistant sidebar. If it isn't there, turn on **Show in sidebar** on the app's Info tab.
2. A short setup screen asks for your hub's address and secret, and explains how to find both.
3. Press **Connect**. Your schedules open once the panel has found your hub.

Everything can be changed later under the cog at the top of the panel.

## Good to know

- **Sign-in.** Home Assistant handles this, so the panel doesn't ask for a password.
- **Backups.** The panel's settings, history, room layout and schedule backups are kept in the app's own folder, so Home Assistant backups include them.
- **The Wiser integration.** This app works alongside a Wiser integration in Home Assistant. Both talk to the hub directly.
- **History.** Graphs fill in while the app runs, as the hub keeps no history of its own.

This is an independent project. It isn't made or supported by Drayton, Wiser or Schneider Electric. It uses the hub's local interface, which isn't officially documented, so a hub firmware update could change how things behave.

Found a problem, or have an idea? Open an issue at https://github.com/BayMax1990/WiserHeat-ControlPanel/issues
