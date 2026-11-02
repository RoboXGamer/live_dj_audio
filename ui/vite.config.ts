import { defineConfig } from 'vite';
import solid from '@solidjs/vite-plugin';
import mkcert from 'vite-plugin-mkcert';

export default defineConfig({
  plugins: [solid(), mkcert()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/signal': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: { target: 'esnext' },
});
