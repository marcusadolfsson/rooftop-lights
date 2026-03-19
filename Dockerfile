# Build stage for frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Build stage for backend
FROM node:20-alpine AS backend-build
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Production stage
FROM node:20-alpine AS production
WORKDIR /app

# Install production dependencies for backend
COPY backend/package*.json ./
RUN npm ci --only=production

# Copy built backend
COPY --from=backend-build /app/backend/dist ./dist

# Copy built frontend to serve statically
COPY --from=frontend-build /app/frontend/dist ./public

# Create data directory for persistent storage
RUN mkdir -p /app/data

# Install curl for health check
RUN apk add --no-cache curl

# Expose ports
EXPOSE 3030
EXPOSE 6454/udp

# Health check: ping API every 30s, restart if 3 consecutive failures
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3030/api/artnet/config || exit 1

# Start the application
CMD ["node", "dist/index.js"]
