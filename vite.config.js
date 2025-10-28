import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Let CodeSandbox’s dynamic host (e.g. *.csb.app) access the dev server.
    // You can tighten this by putting the exact host string here instead of `true`.
    allowedHosts: true,
    // In CSB, HMR is over HTTPS on port 443
    hmr: { clientPort: 443 },
  },
});
