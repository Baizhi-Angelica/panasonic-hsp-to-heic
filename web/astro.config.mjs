import { defineConfig } from 'astro/config';

// Fully static: the converter runs inside the browser, so the deployable
// output is just HTML + one JS bundle + one CSS file. No SSR adapter needed.
export default defineConfig({
  site: 'https://hlgconv.biotech-prank-0u.workers.dev',
  compressHTML: true,
  build: {
    inlineStylesheets: 'auto',
  },
});
