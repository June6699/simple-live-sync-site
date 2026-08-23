FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN mkdir -p public \
    && npm run build:web --if-present \
    && npm run build:node

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY deploy/2.2-public-smoke.mjs deploy/2.3-backend-isolation.mjs deploy/2.6-http-smoke.mjs ./deploy/
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
