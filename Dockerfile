FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu fonts-liberation && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

EXPOSE 3000
CMD ["node", "server.js"]
