FROM node:24.22.3-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
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
