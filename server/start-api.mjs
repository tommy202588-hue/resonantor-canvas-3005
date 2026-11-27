import { createApiServer, loadConfig } from './api-server.mjs';

const config = loadConfig();
const server = createApiServer(config);

server.listen(config.port, config.host, () => {
  console.info(JSON.stringify({
    level: 'info',
    message: 'X-tapnow API proxy listening',
    host: config.host,
    port: config.port,
    upstreamHostCount: config.upstreamHosts.length,
    downloadHostCount: config.downloadHosts.length,
    uploadEnabled: Boolean(config.uploadTarget),
  }));
});
