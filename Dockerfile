# The production image: the API, the built web app it serves, and Tectonic
# for setting CVs and letters in type. Railway builds this file from the repo
# root on every push to the deployed branch.
#
#   docker build -t diligently .
#
# The API serves the web build from /app/web (WEB_DIST) on the same origin,
# runs migrations when it starts, and listens on PORT (Railway sets it) or
# BIND_ADDR.

# -----------------------------------------------------------------------------
# Web: the Vite build
# -----------------------------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# -----------------------------------------------------------------------------
# API: dependencies cached by cargo-chef, then the binary
# -----------------------------------------------------------------------------
FROM rust:1.99-bookworm AS chef
WORKDIR /app
RUN cargo install cargo-chef --locked --version ^0.1

FROM chef AS planner
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS api
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY backend/ ./
RUN cargo build --release --bin diligently-api

# -----------------------------------------------------------------------------
# Runtime
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
ARG TECTONIC_VERSION=0.15.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 curl fontconfig libfontconfig1 libgraphite2-3 libharfbuzz0b libicu72 \
 && rm -rf /var/lib/apt/lists/* \
 # Tectonic sets CVs and letters in type (PDF). A static musl binary that
 # fetches missing LaTeX packages on first use.
 && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin tectonic \
 && chmod +x /usr/local/bin/tectonic \
 && /usr/local/bin/tectonic --version

WORKDIR /app
COPY --from=api /app/target/release/diligently-api /usr/local/bin/diligently-api
COPY --from=api /app/migrations ./migrations
COPY --from=api /app/templates ./templates
COPY --from=web /web/dist ./web

RUN useradd --system --uid 10001 --create-home diligently \
 && mkdir -p /home/diligently/.cache && chown -R diligently:diligently /home/diligently/.cache
USER diligently

# Warm Tectonic's package cache by setting the bundled template once, so the
# first real render does not download about 50MB of LaTeX packages.
RUN cd /tmp && cp /app/templates/cv.tex prewarm.tex \
 && tectonic --chatter=minimal --outdir /tmp prewarm.tex \
 && rm -f /tmp/prewarm.*

ENV RUST_LOG=diligently_api=info,tower_http=info \
    WEB_DIST=/app/web \
    TECTONIC_BIN=tectonic \
    COOKIE_SECURE=true \
    TRUST_PROXY=true
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
    CMD curl -fsS "http://localhost:${PORT:-8080}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/diligently-api"]
