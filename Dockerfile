FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV HOST=0.0.0.0 PORT=8787 DATA_DIR=/data NODE_ENV=production
EXPOSE 8787
VOLUME /data
CMD ["node", "server.mjs"]
