FROM mcr.microsoft.com/playwright:v1.58.2-noble AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.58.2-noble

WORKDIR /app

ENV NODE_ENV=production

ARG CAMOUFOX_URL=https://github.com/daijro/camoufox/releases/download/v152.0.4-beta.28/camoufox-152.0.4-beta.28-lin.x86_64.zip
ARG CAMOUFOX_SHA256=924f3109ccd6d47cd6a0384d67a345fadf975d48b6319f8dbbd5954c588982bd
# Dated defaults preserve source-build callers; qualification binds freshly verified overrides.
# Upstream retains only two releases. Never replace the checksum with a latest fallback.
ARG CAMOUFOX_GEOIP_URL=https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.09.04/GeoLite2-City.mmdb
ARG CAMOUFOX_GEOIP_SHA256=85974cd715333c1dab9e23fa0685483a8c9316d372e69164f836d1f812c41ff8
ARG CAMOUFOX_UBO_URL=https://addons.mozilla.org/firefox/downloads/file/4940584/ublock_origin-1.73.0.xpi
ARG CAMOUFOX_UBO_SHA256=bccc51a773150af4af6e1fd62c7bfdeb7238b79ff2381b998fa9f2e38f64786a

RUN node -e "\
  const url = process.env.CAMOUFOX_GEOIP_URL ?? ''; \
  const sha = process.env.CAMOUFOX_GEOIP_SHA256 ?? ''; \
  const match = \
    /^https:\/\/github\.com\/P3TERX\/GeoLite\.mmdb\/releases\/download\/(\d{4}\.\d{2}\.\d{2})\/GeoLite2-City\.mmdb$/ \
    .exec(url); \
  const day = match ? match[1].replaceAll('.', '-') : ''; \
  const date = new Date(day + 'T00:00:00.000Z'); \
  const validDate = !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === day; \
  if (!match || match[0] !== url || !validDate || sha.length !== 64 || /[^0-9a-f]/.test(sha)) { \
    console.error('GeoIP build inputs require an exact dated P3TERX URL and lowercase SHA-256'); \
    process.exit(1); \
  }" \
  && apt-get update \
  && apt-get install -y --no-install-recommends curl poppler-utils unzip \
  && command -v Xvfb \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN ./node_modules/.bin/playwright install chromium \
  && ./node_modules/.bin/patchright install chromium \
  && mkdir -p /root/.cache/camoufox/addons/UBO \
  && curl -fsSL "$CAMOUFOX_URL" -o /tmp/camoufox.zip \
  && echo "$CAMOUFOX_SHA256  /tmp/camoufox.zip" | sha256sum -c - \
  && unzip -q /tmp/camoufox.zip -d /root/.cache/camoufox \
  && curl -fsSL --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 120 \
    "$CAMOUFOX_GEOIP_URL" -o /root/.cache/camoufox/GeoLite2-City.mmdb \
  && echo "$CAMOUFOX_GEOIP_SHA256  /root/.cache/camoufox/GeoLite2-City.mmdb" | sha256sum -c - \
  && curl -fsSL "$CAMOUFOX_UBO_URL" -o /tmp/ubo.xpi \
  && echo "$CAMOUFOX_UBO_SHA256  /tmp/ubo.xpi" | sha256sum -c - \
  && unzip -q /tmp/ubo.xpi -d /root/.cache/camoufox/addons/UBO \
  && printf '%s' '{"version":"152.0.4","release":"beta.28"}' > /root/.cache/camoufox/version.json \
  && test -x /root/.cache/camoufox/camoufox-bin \
  && rm -f /tmp/camoufox.zip /tmp/ubo.xpi
COPY --from=build /app/dist ./dist

# OVD-419 qualification requires an explicitly supplied, independently verified SHA.
ARG WORKER_BUILD_VERSION=unknown
ENV WORKER_BUILD_VERSION=${WORKER_BUILD_VERSION}
RUN ["node", "-e", "const version = process.env.WORKER_BUILD_VERSION ?? ''; if (version !== 'unknown' && (version.length !== 40 || /[^0-9a-f]/.test(version))) { console.error('WORKER_BUILD_VERSION must be unknown or a full lowercase Git SHA'); process.exit(1); }"]

EXPOSE 8080

CMD ["node", "dist/index.js"]
