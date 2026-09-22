# Reproducible build, and a way to run this anywhere -- Railway uses Nixpacks by
# default, but a plain image also runs on Fly, Render, a VPS or your laptop.
FROM node:22-alpine

WORKDIR /app

# Dependencies first: this layer is cached until package.json actually changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# The save file is the whole arcade -- every account, every chip. Mount a volume
# here or it dies with the container.
ENV DATA_FILE=/app/data/arcade.json
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=4900
EXPOSE 4900

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4900)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
