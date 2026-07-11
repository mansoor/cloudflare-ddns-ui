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

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# App source
COPY src ./src
COPY web ./web
COPY --from=cssbuild /app/public ./public

# Data volume for config + secrets
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATA_DIR=/data
ENV PORT=8080
VOLUME ["/data"]
EXPOSE 8080

USER node
CMD ["node", "src/server.js"]
