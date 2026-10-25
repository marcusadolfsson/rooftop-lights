# Build stage for frontend
FROM node:24-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Build stage for backend (TypeScript only; native modules are built in backend-deps)
FROM node:24-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --ignore-scripts
COPY backend/ ./
RUN npm run build

# Production dependencies (better-sqlite3 compiles from source if no prebuilt binary matches)
FROM node:24-alpine AS backend-deps
WORKDIR /app/backend
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Production stage
FROM node:24-alpine AS production
WORKDIR /app

# curl for the health check, tzdata so TZ (e.g. America/New_York) works for schedules
RUN apk add --no-cache curl tzdata

# Production dependencies for backend
COPY backend/package*.json ./
COPY --from=backend-deps /app/backend/node_modules ./node_modules

# Copy built backend
COPY --from=backend-build /app/backend/dist ./dist

# Copy built frontend to serve statically
COPY --from=frontend-build /app/frontend/dist ./public

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Expose ports
EXPOSE 3030
EXPOSE 6454/udp

# Health check: ping /health every 30s, restart if 3 consecutive failures
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3030/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
