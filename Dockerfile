# WiserHeat Control Panel, for Docker. How to use it: docs/DOCKER.md
#
# Listens on port 8765 on every address, keeps settings and data in /data, and runs as the
# unprivileged "node" user (uid 1000). The first visitor is asked to create a password, unless
# PANEL_PASSWORD is set.
FROM node:22-alpine

LABEL org.opencontainers.image.title="WiserHeat Control Panel" \
      org.opencontainers.image.description="See and control your whole home's Drayton Wiser heating on one screen." \
      org.opencontainers.image.source="https://github.com/BayMax1990/WiserHeat-ControlPanel"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app
COPY server.js ./
COPY public ./public

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8765) + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD [ "node", "server.js" ]
