import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend port: use VITE_API_PORT env var or default to 3030
const apiPort = process.env.VITE_API_PORT || '3030';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['rooftop.onestpete.com'],
    proxy: {
      '/health': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
