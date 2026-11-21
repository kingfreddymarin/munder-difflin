// Paramount ships ui/dist; the legacy renderer is retained for optional development only.
import config from './electron.vite.config';
export default { main: config.main, preload: config.preload };
