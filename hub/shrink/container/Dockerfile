# The picture shrinker: sharp behind one HTTP route. Cloudflare runs it as linux/amd64; npm installs sharp's
# prebuilt libvips for that platform.
FROM node:22.23.2-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
