# Meteorologist, as an image.
#
# Built with Bun, which is what the repository uses everywhere else and
# what the lockfile is for, and run with Node on Next's standalone
# output: a server.js and only the node_modules it actually loads, so
# the image carries neither Bun nor the build toolchain.
#
# The build fetches the fonts from Google Fonts (next/font), so it
# needs network access.

FROM oven/bun:1.4.2 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM node:24-bookworm-slim AS run
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The standalone server serves the static files when they sit beside it
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static

USER node
EXPOSE 3000
CMD ["node", "server.js"]
