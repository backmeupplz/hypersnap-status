FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=3000 DATA_DIR=/data NODE_NO_WARNINGS=1
EXPOSE 3000
# history lives in /data (a volume); a new empty volume takes this owner from the image
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "server.mjs"]
