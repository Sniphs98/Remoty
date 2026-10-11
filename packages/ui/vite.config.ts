import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Fixed dev port; the Electron main process loads it via REMOTY_DEV_SERVER_URL.
export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      // SPA, served by Electron's main process over a custom `app://` origin
      // (packages/electron/src/appProtocol.ts) rather than a bare `file://` load,
      // so this build's root-absolute asset paths (`/_app/...`) resolve correctly.
      // The client-side router never needs the fallback page since the app always
      // starts at `/`, but adapter-static still wants one.
      adapter: adapter({ fallback: 'index.html' }),
      // SvelteKit 3 drops the built-in `$lib` alias in favour of `#lib` subpath
      // imports; declaring it keeps the existing `$lib/...` imports working. Kit
      // warns that `alias` is deprecated — moving to `#lib` is a separate change.
      alias: { $lib: 'src/lib' }
    })
  ],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'esnext' }
});
