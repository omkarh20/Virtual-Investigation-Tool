import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

function publicManifestsPlugin() {
  return {
    name: 'public-manifests-plugin',
    configureServer(server) {
      server.middlewares.use('/api/public-manifests', (req, res) => {
        const publicDir = path.resolve(__dirname, 'public');
        const manifests = [];
        
        try {
          if (fs.existsSync(publicDir)) {
            const items = fs.readdirSync(publicDir);
            for (const item of items) {
              const itemPath = path.join(publicDir, item);
              if (fs.statSync(itemPath).isDirectory()) {
                if (fs.existsSync(path.join(itemPath, 'manifest.json'))) {
                  manifests.push(item);
                }
              }
            }
          }
        } catch (e) {
          console.error("Error reading public manifests:", e);
        }
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.end(JSON.stringify(manifests));
      });
    }
  };
}

export default defineConfig({
  plugins: [publicManifestsPlugin()],
  server: {
    host: true, // Listen on all network interfaces (0.0.0.0)
  },
});
