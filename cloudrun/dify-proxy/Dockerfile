FROM node:20-alpine

WORKDIR /app

# 镜像里只放这一个转发脚本，不放站点静态资源（静态资源走 GitHub Pages）
COPY --chown=node:node main.js ./
COPY --chown=node:node package.json ./

ENV NODE_ENV=production \
    PORT=8080

USER node
EXPOSE 8080

CMD ["node", "main.js"]
