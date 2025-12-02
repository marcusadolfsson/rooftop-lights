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

# Expose ports
EXPOSE 3000
EXPOSE 6454/udp

# Start the application
CMD ["node", "dist/index.js"]
