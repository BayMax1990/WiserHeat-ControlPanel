# Built by Home Assistant on the user's machine. app/ is a copy of the panel, made by
# tools/sync-ha-app.js at the repository root; don't edit it by hand.
FROM ghcr.io/home-assistant/base:latest

RUN apk add --no-cache nodejs

COPY app /app

# Run as a Home Assistant app: listen for Home Assistant's ingress proxy on 8099, trust its
# login, and keep settings and data in /data, which Home Assistant includes in its backups.
ENV HOME_ASSISTANT_APP=1 \
    HOST=0.0.0.0 \
    PORT=8099 \
    DATA_DIR=/data

WORKDIR /app
CMD [ "node", "/app/server.js" ]
