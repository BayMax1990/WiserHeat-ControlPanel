// Copies the panel (server.js and public/) into the Home Assistant app folder, wiserheat-panel/app/.
// Home Assistant builds the app from that folder alone, so run this before committing a change:
//
//   node tools/sync-ha-app.js
//
// It warns when the panel has changed but the app's version hasn't, because Home Assistant only
// offers users an update when the version in wiserheat-panel/config.yaml goes up.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(ROOT, 'wiserheat-panel');
const TARGET = path.join(APP_DIR, 'app');
const STAMP = path.join(APP_DIR, '.synced'); // "version hash" from the last run
const SOURCES = ['server.js', 'public'];

function hashOf(dir) {
  const h = crypto.createHash('sha256');
  const walk = (p, rel) => {
    if (fs.statSync(p).isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) walk(path.join(p, name), `${rel}/${name}`);
    } else {
      h.update(rel).update('\0').update(fs.readFileSync(p)).update('\0');
    }
  };
  for (const s of SOURCES) walk(path.join(dir, s), s);
  return h.digest('hex').slice(0, 16);
}

const version = (fs.readFileSync(path.join(APP_DIR, 'config.yaml'), 'utf8').match(/^version:\s*"?([^"\s]+)"?/m) || [])[1];
if (!version) throw new Error('No version found in wiserheat-panel/config.yaml');

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });
for (const s of SOURCES) fs.cpSync(path.join(ROOT, s), path.join(TARGET, s), { recursive: true });

const hash = hashOf(TARGET);
const [lastVersion, lastHash] = fs.existsSync(STAMP) ? fs.readFileSync(STAMP, 'utf8').trim().split(' ') : [];
fs.writeFileSync(STAMP, `${version} ${hash}\n`);

console.log(`Copied the panel into wiserheat-panel/app (version ${version}).`);
if (lastHash && lastHash !== hash && lastVersion === version) {
  console.warn(`\nThe panel has changed since version ${version} was synced, but the version hasn't.`);
  console.warn('Raise "version" in wiserheat-panel/config.yaml, add a line to wiserheat-panel/CHANGELOG.md,');
  console.warn('then run this again, so Home Assistant offers the update.');
}
