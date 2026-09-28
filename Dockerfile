FROM node:20-slim

# Build tools needed for better-sqlite3 native module
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only the betika-live app folder
COPY betika-live/package.json betika-live/package-lock.json* ./

# Install production dependencies
RUN npm install --omit=dev

# Copy app source
COPY betika-live/ .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
