import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build --mode single` 打包成單個 HTML，並強制使用瀏覽器內模擬（不需要協調服務）
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'single' ? [viteSingleFile()] : [])],
  define: { __FORCE_DEMO__: JSON.stringify(mode === 'single') },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 4000,
  },
  server: { port: 5173 },
}));
