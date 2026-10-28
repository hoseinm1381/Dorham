FROM node:24.22.1-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
FROM node:24.22.1-bookworm-slim
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data && chown -R node:node /data /app
ENV NODE_ENV=production HOST=0.0.0.0 SERVER_PORT=3001 DATA_DIR=/data COOKIE_SECURE=true
USER node
VOLUME ["/data"]
EXPOSE 3001
CMD ["npm", "start"]
