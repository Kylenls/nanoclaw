import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.resolve(__dirname, '..', 'store', 'messages.db'));

const GROUPS_ROOT = '/root/nanoclaw/groups';

const peerMounts = {
  'discord_arc2-oracle': [
    { hostPath: `${GROUPS_ROOT}/discord_arc2-taskmaster`, containerPath: 'taskmaster', readonly: true },
    { hostPath: `${GROUPS_ROOT}/discord_arc2-watcher`, containerPath: 'watcher', readonly: true },
  ],
  'discord_arc2-taskmaster': [
    { hostPath: `${GROUPS_ROOT}/discord_arc2-oracle`, containerPath: 'oracle', readonly: true },
    { hostPath: `${GROUPS_ROOT}/discord_arc2-watcher`, containerPath: 'watcher', readonly: true },
  ],
  'discord_arc2-watcher': [
    { hostPath: `${GROUPS_ROOT}/discord_arc2-oracle`, containerPath: 'oracle', readonly: true },
    { hostPath: `${GROUPS_ROOT}/discord_arc2-taskmaster`, containerPath: 'taskmaster', readonly: true },
  ],
};

const update = db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?');

for (const [folder, mounts] of Object.entries(peerMounts)) {
  const config = JSON.stringify({ additionalMounts: mounts });
  const r = update.run(config, folder);
  console.log(`${folder}: changes=${r.changes}`);
}

const verify = db.prepare("SELECT folder, container_config FROM registered_groups WHERE folder LIKE 'discord_arc2-%' ORDER BY folder").all();
for (const row of verify) {
  console.log(`\n${row.folder}:`);
  console.log(JSON.parse(row.container_config));
}
db.close();
