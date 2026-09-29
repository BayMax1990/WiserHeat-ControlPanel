# Built by Home Assistant on the user's machine. app/ is a copy of the panel, made by
# tools/sync-ha-app.js at the repository root; don't edit it by hand.
#
# A plain Node.js image (for PCs and 64-bit Raspberry Pis), started by Docker's own init
# (config.yaml leaves "init" at its default). Home Assistant's base image starts programs through
# s6-overlay, which doesn't pass these environment variables on.
FROM node:22-alpine

COPY app /app

# Run as a Home Assistant app: listen for Home Assistant's ingress proxy on 8099, trust its
# login, and keep settings and data in /data, which Home Assistant includes in its backups.
# (server.js also works this out from /data/options.json, which Home Assistant always provides.)
ENV HOME_ASSISTANT_APP=1 \
    HOST=0.0.0.0 \
    PORT=8099 \
    DATA_DIR=/data

WORKDIR /app
CMD [ "node", "/app/server.js" ]
