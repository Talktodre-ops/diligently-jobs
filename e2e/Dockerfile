# Browser test runner. The Playwright image ships Chromium, Firefox and WebKit;
# Edge is added here because it is a branded build Playwright installs from
# Microsoft's repository, which needs root at build time. Keep the tag equal
# to the @playwright/test version in package.json.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

RUN npx -y playwright@1.65.0 install --with-deps msedge \
 && /opt/microsoft/msedge/msedge --version

# Tests run as the host user (compose sets user:), so results written into
# the bind mount stay owned by you. Give that user a writable home.
ENV HOME=/tmp/e2e-home
RUN mkdir -p /tmp/e2e-home && chmod 1777 /tmp/e2e-home
WORKDIR /e2e
