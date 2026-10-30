# fde-agent：Mastra + 向量检索的问答服务
# 多阶段：依赖层单独缓存，运行镜像只带 node_modules、src 与索引数据。

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node data ./data

USER node
EXPOSE 8080

# 端口探测由云托管负责；这里只做一次启动自检日志
CMD ["node", "src/server.js"]
