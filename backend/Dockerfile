# Multi-stage build. Build stage uses cargo-chef for dep caching; runtime stage
# is a slim debian with just libssl + ca-certificates + the binary.
#
# Result: ~80MB final image (vs ~1.5GB if we shipped the build stage).

# -----------------------------------------------------------------------------
# Stage 1 — recipe (just compute the dep graph for caching)
# -----------------------------------------------------------------------------
FROM rust:1.83-bookworm AS chef
WORKDIR /app
RUN cargo install cargo-chef --locked --version ^0.1
COPY Cargo.toml Cargo.lock ./
RUN cargo chef prepare --recipe-path recipe.json

# -----------------------------------------------------------------------------
# Stage 2 — cook deps (cached layer, only invalidated when Cargo.lock changes)
# -----------------------------------------------------------------------------
FROM rust:1.83-bookworm AS builder
WORKDIR /app
RUN cargo install cargo-chef --locked --version ^0.1
COPY --from=chef /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# Now copy actual source and build. With deps cached, this is fast on iter.
COPY . .
RUN cargo build --release --bin diligently-api

# -----------------------------------------------------------------------------
# Stage 3 — runtime
# -----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
ARG TECTONIC_VERSION=0.15.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 curl fontconfig libfontconfig1 libgraphite2-3 libharfbuzz0b libicu72 \
 && rm -rf /var/lib/apt/lists/* \
 # Install tectonic — required by the cv_render job (PDF output).
 # Single-file static musl binary; fetches missing LaTeX packages on first use.
 && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin tectonic \
 && chmod +x /usr/local/bin/tectonic \
 && /usr/local/bin/tectonic --version

WORKDIR /app
COPY --from=builder /app/target/release/diligently-api /usr/local/bin/diligently-api
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/templates ./templates

# Non-root user
RUN useradd --system --uid 10001 --create-home diligently \
 && mkdir -p /home/diligently/.cache && chown -R diligently:diligently /home/diligently/.cache
USER diligently

# Pre-warm tectonic's per-user package cache by compiling the bundled template
# once. Without this, the first runtime render downloads ~50MB of LaTeX
# packages (fontawesome5, marvosym, tabularx, hyperref, etc.) and takes
# 30-60s — moving that cost into the image build keeps live renders snappy.
RUN cd /tmp && cp /app/templates/cv.tex prewarm.tex \
 && tectonic --chatter=minimal --outdir /tmp prewarm.tex \
 && rm -f /tmp/prewarm.*

ENV RUST_LOG=diligently_api=info,tower_http=info
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:8787/health || exit 1

ENTRYPOINT ["/usr/local/bin/diligently-api"]
