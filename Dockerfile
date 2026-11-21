FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev || true
COPY db ./db
COPY src ./src
RUN mkdir -p data
VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
