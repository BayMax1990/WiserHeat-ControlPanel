#!/bin/sh
# Starts the panel inside Docker.
#
# The image starts as root only so it can choose who the panel runs as:
# - normally, it hands over to the unprivileged "node" user (uid 1000);
# - in Home Assistant, it stays root, because Home Assistant gives apps a /data folder that only
#   root can write to (it always puts options.json there, which is how this script tells).
# If the container was started as another user (for example --user 99:100), it just runs.
set -e

if [ "$(id -u)" = "0" ] && [ ! -f /data/options.json ]; then
  exec su-exec node:node node /app/server.js
fi
exec node /app/server.js
