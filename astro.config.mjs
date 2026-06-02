import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://fanren.tech',
  build: {
    outDir: 'dist'
  },
  output: 'static',
});