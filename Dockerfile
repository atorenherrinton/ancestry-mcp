FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY mcp-server.js ./

CMD ["node", "mcp-server.js"]
