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
ARG CAMOUFOX_GEOIP_URL=https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.08.25/GeoLite2-City.mmdb
ARG CAMOUFOX_GEOIP_SHA256=b481e34bdfbeb937434d09b47d89622c36051560c5f64853b54e081678c7df74
ARG CAMOUFOX_UBO_URL=https://addons.mozilla.org/firefox/downloads/file/4940584/ublock_origin-1.73.0.xpi
ARG CAMOUFOX_UBO_SHA256=bccc51a773150af4af6e1fd62c7bfdeb7238b79ff2381b998fa9f2e38f64786a

RUN apt-get update \
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
  && curl -fsSL "$CAMOUFOX_GEOIP_URL" -o /root/.cache/camoufox/GeoLite2-City.mmdb \
  && echo "$CAMOUFOX_GEOIP_SHA256  /root/.cache/camoufox/GeoLite2-City.mmdb" | sha256sum -c - \
  && curl -fsSL "$CAMOUFOX_UBO_URL" -o /tmp/ubo.xpi \
  && echo "$CAMOUFOX_UBO_SHA256  /tmp/ubo.xpi" | sha256sum -c - \
  && unzip -q /tmp/ubo.xpi -d /root/.cache/camoufox/addons/UBO \
  && printf '%s' '{"version":"152.0.4","release":"beta.28"}' > /root/.cache/camoufox/version.json \
  && test -x /root/.cache/camoufox/camoufox-bin \
  && rm -f /tmp/camoufox.zip /tmp/ubo.xpi
COPY --from=build /app/dist ./dist

EXPOSE 8080

CMD ["node", "dist/index.js"]
