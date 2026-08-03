ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-slim

WORKDIR /app

ENV NODE_ENV=development
ENV CI=true
ENV NODE_OPTIONS=--max-old-space-size=3072

# Playwright system deps + Chromium. Chromium is the only engine that ships
# BarcodeDetector, so it is also the only engine that can e2e the receive path.
RUN apt-get update && \
    npx -y playwright@1.62.0 install chromium --with-deps && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

CMD ["bash"]
