FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY lib ./lib
COPY mcp-server.js ./
COPY scripts ./scripts

CMD ["node", "mcp-server.js"]
