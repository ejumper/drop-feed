FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js scan.js schedule.js playlist.js media.js feeds.js pages.js ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
