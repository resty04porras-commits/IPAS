import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  const requestedPort = Number.parseInt(env.PORT || '3000', 10);
  const port = Number.isNaN(requestedPort) ? 3000 : requestedPort;
  const preferredPublicHost = env.PREFERRED_PUBLIC_HOST || 'iictdasset.lbfinc.org';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      host: env.BIND_HOST || '0.0.0.0',
      port,
      allowedHosts: true,
      hmr: env.DISABLE_HMR === 'true' ? false : undefined,
    },
    // preview is a development-only tool; use a port that never conflicts with
    // the production Express server on 3000.  The production command is:
    //   ./run-web-app.sh      (or PORT=3000 NODE_ENV=production tsx server.ts)
    // Do NOT use `vite preview` in production — it has no API routes.
    preview: {
      host: env.BIND_HOST || '0.0.0.0',
      port: 4173,
      strictPort: false,
    },
  };
});
