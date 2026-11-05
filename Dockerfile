FROM node:24-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@10.34.9

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @crossfare/web build

ENV PORT=8787 DATABASE_PATH=/data/crossfare.db WEB_ROOT=../web/dist
EXPOSE 8787
WORKDIR /app/apps/api
CMD ["node", "src/main.ts"]
