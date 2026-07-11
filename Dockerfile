# --- Stage 1: build Tailwind CSS ---
# Debian-based (glibc) image: sodium-native (via @fastify/secure-session) ships
# reliable prebuilt binaries for glibc; the Alpine/musl prebuild is flaky.
FROM node:20-slim AS cssbuild
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tailwind.config.js ./
COPY web ./web
RUN npm run build:css

# --- Stage 2: runtime ---
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# gosu lets the entrypoint drop from root to the node user after fixing volume
# permissions.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# App source
COPY src ./src
COPY web ./web
COPY --from=cssbuild /app/public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Data volume for config + secrets
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATA_DIR=/data
ENV PORT=8080
VOLUME ["/data"]
EXPOSE 8080

# Start as root so the entrypoint can chown the (possibly root-owned) /data bind
# mount, then it re-execs the app as the unprivileged node user.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
