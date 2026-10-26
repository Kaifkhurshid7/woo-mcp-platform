import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard proxies /api and /mcp to a locally running gateway.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:8080', '/mcp': 'http://localhost:8080' } },
});
