# WiserHeat Control Panel, for Docker and the Home Assistant app. How to use it: docs/DOCKER.md
#
# Listens on port 8765 on every address (8099 in Home Assistant), keeps settings and data in
# /data, and runs as the unprivileged "node" user (uid 1000) except in Home Assistant; see
# wiserheat-start.sh. The first visitor is asked to create a password, unless PANEL_PASSWORD is set.
FROM node:22-alpine

LABEL org.opencontainers.image.title="WiserHeat Control Panel" \
      org.opencontainers.image.description="See and control your whole home's Drayton Wiser heating on one screen." \
      org.opencontainers.image.source="https://github.com/BayMax1990/WiserHeat-ControlPanel" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Oliver Bundy"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATA_DIR=/data

RUN apk add --no-cache su-exec \
 && mkdir -p /data \
 && chown node:node /data

WORKDIR /app
COPY server.js package.json ./
COPY public ./public
COPY wiserheat-start.sh /usr/local/bin/wiserheat-start
# Strip Windows line endings, in case the script was checked out on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/wiserheat-start && chmod +x /usr/local/bin/wiserheat-start

VOLUME /data
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const p = process.env.PORT || (require('fs').existsSync('/data/options.json') ? 8099 : 8765); fetch('http://127.0.0.1:' + p + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT [ "/usr/local/bin/wiserheat-start" ]
