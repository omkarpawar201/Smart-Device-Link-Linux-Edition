import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const rendererDir = fileURLToPath(new URL('./renderer', import.meta.url));
const outDir = fileURLToPath(new URL('./dist', import.meta.url));

export default defineConfig({
    plugins: [react(), tailwindcss()],
    base: './',
    root: rendererDir,
    build: {
        outDir,
        emptyOutDir: true,
    },
    server: {
        port: 5173,
        strictPort: true,
    },
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./renderer/src', import.meta.url)),
        },
    },
});
