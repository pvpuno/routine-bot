FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY db ./db
COPY src ./src
RUN mkdir -p data
VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
