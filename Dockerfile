FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY . .

RUN npm --workspace @app/shared run build \
  && npm --workspace @app/api run build

EXPOSE 3000

CMD ["node", "apps/api/dist/index.js"]
