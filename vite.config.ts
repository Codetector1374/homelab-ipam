import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], root: 'web', build: { outDir: '../dist/web', emptyOutDir: false }, server: { proxy: { '^/api(?:/|$)': 'http://127.0.0.1:3000', '^/auth(?:/|$)': 'http://127.0.0.1:3000' } } });
