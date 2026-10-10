# DB Console — small image, no build step.
#   docker build -t db-console .
#   docker run -p 3000:3000 -v dbc-data:/data -e SESSION_SECRET=$(openssl rand -hex 32) -e DBC_ENCRYPTION_KEY=... db-console
FROM node:20-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api ./api
COPY public ./public
COPY server.js config_sample.js ./
# /data holds connections, users, sessions and logs: keep it on a volume.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null || exit 1
CMD ["node", "server.js"]
