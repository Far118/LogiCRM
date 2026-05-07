/**
 * vite.config.js — MPA-конфигурация Vite для LogiCRM frontend.
 */

import { defineConfig } from 'vite';
import { resolve }      from 'path';

export default defineConfig({
  root: '.',
  base: '/',

  build: {
    // esnext разрешает top-level await, который используется во всех HTML-страницах
    // (`const session = await initUI(...)`).
    // Дефолтный таргет Vite (es2020/chrome87) его не поддерживает.
    target:      'esnext',
    outDir:      'dist',
    emptyOutDir: true,

    rollupOptions: {
      input: {
        index:       resolve(__dirname, 'index.html'),
        login:       resolve(__dirname, 'login.html'),
        companies:   resolve(__dirname, 'companies.html'),
        company:     resolve(__dirname, 'company.html'),
        deals:       resolve(__dirname, 'deals.html'),
        activities:  resolve(__dirname, 'activities.html'),
        requests:    resolve(__dirname, 'requests.html'),
        carriers:    resolve(__dirname, 'carriers.html'),
        reports:     resolve(__dirname, 'reports.html'),
        plans:       resolve(__dirname, 'plans.html'),
        import_page: resolve(__dirname, 'import.html'),
        users:       resolve(__dirname, 'admin/users.html'),
      },
    },
  },

  server: {
    port: 5173,
    proxy: {
      '/api': {
        target:       'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
