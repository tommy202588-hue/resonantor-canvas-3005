import { createApiServer, loadConfig } from './api-server.mjs';
import { provisionLocalAdministrator } from './admin-bootstrap.mjs';

const config = loadConfig({
    ...process.env,
    API_HOST: '127.0.0.1',
    API_PORT: '5113',
    CANVAS_DATA_DIR: '/var/lib/resonantor-canvas-test',
    CANVAS_PUBLIC_BASE_PATH: '/resonantor-canvas',
    CANVAS_SESSION_COOKIE: 'resonantor_canvas_test_session',
    CANVAS_SESSION_COOKIE_PATH: '/resonantor-canvas',
    CANVAS_COOKIE_SECURE: 'true',
    PUBLIC_ORIGINS: 'https://www.resonantor.cn',
});
const administrator = provisionLocalAdministrator({ ...config, adminLoginUrl: 'https://www.resonantor.cn/resonantor-canvas/admin' });
if (administrator.created) console.info('Test administrator initialized. Credentials remain in the private data directory; no secrets are logged.');
const server = createApiServer(config);
server.listen(config.port, config.host, () => console.info('Resonantor isolated web-test API listening on 127.0.0.1:5113'));
