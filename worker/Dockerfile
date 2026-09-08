FROM mcr.microsoft.com/playwright:v1.58.2-noble AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
# Keep the reviewed package inputs immutable even if npm recalculates peer metadata.
RUN sha256sum package.json package-lock.json > /tmp/worker-package-inputs.sha256 \
  && npm ci \
  && sha256sum -c /tmp/worker-package-inputs.sha256

COPY src ./src
RUN npm run build
RUN npm prune --omit=dev --no-save \
  && sha256sum -c /tmp/worker-package-inputs.sha256

FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

ENV NODE_ENV=production

ARG CAMOUFOX_URL=https://github.com/daijro/camoufox/releases/download/v152.0.4-beta.28/camoufox-152.0.4-beta.28-lin.x86_64.zip
ARG CAMOUFOX_SHA256=924f3109ccd6d47cd6a0384d67a345fadf975d48b6319f8dbbd5954c588982bd
ARG CAMOUFOX_UBO_URL=https://addons.mozilla.org/firefox/downloads/file/4940584/ublock_origin-1.73.0.xpi
ARG CAMOUFOX_UBO_SHA256=bccc51a773150af4af6e1fd62c7bfdeb7238b79ff2381b998fa9f2e38f64786a

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl poppler-utils unzip \
  && command -v Xvfb \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY scripts/install-camoufox.mjs ./scripts/install-camoufox.mjs
RUN ./node_modules/.bin/playwright install chromium \
  && ./node_modules/.bin/patchright install chromium \
  && mkdir -p /root/.cache/camoufox/addons/UBO \
  && curl -fsSL "$CAMOUFOX_URL" -o /tmp/camoufox.zip \
  && echo "$CAMOUFOX_SHA256  /tmp/camoufox.zip" | sha256sum -c - \
  && unzip -q /tmp/camoufox.zip -d /root/.cache/camoufox \
  && curl -fsSL "$CAMOUFOX_UBO_URL" -o /tmp/ubo.xpi \
  && echo "$CAMOUFOX_UBO_SHA256  /tmp/ubo.xpi" | sha256sum -c - \
  && unzip -q /tmp/ubo.xpi -d /root/.cache/camoufox/addons/UBO \
  && printf '%s' '{"version":"152.0.4","release":"beta.28"}' > /root/.cache/camoufox/version.json \
  && test -x /root/.cache/camoufox/camoufox-bin \
  && rm -f /tmp/camoufox.zip /tmp/ubo.xpi
COPY --from=build /app/dist ./dist

# Fail the new image build if a browser archive or dependency ever adds a database.
RUN find /app /root/.cache /ms-playwright -iname '*.mmdb' -print > /tmp/worker-mmdb-inventory \
  && test ! -s /tmp/worker-mmdb-inventory

# OVD-419 qualification requires an explicitly supplied, independently verified SHA.
ARG WORKER_BUILD_VERSION=unknown
ENV WORKER_BUILD_VERSION=${WORKER_BUILD_VERSION}
RUN ["node", "-e", "const version = process.env.WORKER_BUILD_VERSION ?? ''; if (version !== 'unknown' && (version.length !== 40 || /[^0-9a-f]/.test(version))) { console.error('WORKER_BUILD_VERSION must be unknown or a full lowercase Git SHA'); process.exit(1); }"]

EXPOSE 8080

CMD ["node", "dist/index.js"]
