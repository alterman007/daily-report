FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/daily-report.db \
    TZ=Asia/Shanghai

RUN mkdir -p /data && chown -R node:node /app /data

# 以 root 启动，便于修正宿主机数据目录的属主；server.js 打开数据库前会降为 node。
USER root
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
