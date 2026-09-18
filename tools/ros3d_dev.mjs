// Local fixture frontend. Serves test config in memory without overwriting public/config.
import { createServer } from '../app/node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../app', import.meta.url));
const fixtureConfig = `
name: ros3d-fixture
ws_port: 11000
tabs: [ros, ros3d, clouds, debug]
ros3d:
  fixed_frame: map
  time_source: ros_clock
  show_frames: true
  displays:
    - id: ouster
      topic: /ouster/points
      history_s: 3
      color: {mode: height}
home:
  version: 1
  title: ROS 3D test fixture
  widgets:
    - type: rosbag_playback
      label: Replay controls
    - type: pointcloud
      label: Ouster point cloud
`;
const server = await createServer({ root, configFile: `${root}/vite.config.ts`, server: { host: '127.0.0.1', port: 5178 },
  plugins: [{ name: 'ros3d-fixture-config', configureServer(s) { s.middlewares.use((req, res, next) => {
    if (req.url?.split('?')[0] === '/config/dashboard.yaml') { res.setHeader('Content-Type', 'text/yaml'); res.end(fixtureConfig); }
    else next();
  }); } }] });
await server.listen(); server.printUrls();
