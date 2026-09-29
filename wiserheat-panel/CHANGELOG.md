# Changelog

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
