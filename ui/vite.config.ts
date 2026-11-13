import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The terminal uses Munder's exact xterm stack (xterm 5.5, fit, webgl, unicode11),
// resolved from the app repo's own node_modules so both renderers stay on one version.
// See src/components/app/terminal/TERMINAL-why.md.
const XTERM = /^@xterm\/(xterm|addon-fit|addon-webgl|addon-unicode11)(\/.*)?$/;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: XTERM, replacement: path.resolve(__dirname, '../node_modules/@xterm/$1$2') },
    ],
  },
});
