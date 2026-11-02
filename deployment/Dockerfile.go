# Build context: contents of artifacts/server-<version>-go (Linux x86-64).
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 libwebp7 libwebpdemux2 libwebpmux3 && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home dorham
WORKDIR /app
COPY --chown=dorham:dorham . .
RUN chmod 755 apps/api-go/dist/dorham && mkdir -p /data && chown dorham:dorham /data
ENV NODE_ENV=production HOST=0.0.0.0 SERVER_PORT=3001 DATA_DIR=/data COOKIE_SECURE=true
USER dorham
VOLUME ["/data"]
EXPOSE 3001
ENTRYPOINT ["./apps/api-go/dist/dorham"]
