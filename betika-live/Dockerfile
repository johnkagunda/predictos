FROM node:20-slim

# Build tools needed for better-sqlite3 native module
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install dependencies (rebuilds native modules for this platform)
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

# Render injects PORT via environment variable
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
