// `npm run models`: rebuild public/models/*.glb from art/build_props.py in
// Blender, run headless. Finds Blender at $BLENDER_PATH, then the usual
// install places, then on the PATH.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function findBlender() {
  if (process.env.BLENDER_PATH) return process.env.BLENDER_PATH;
  const roots = [
    'C:/Program Files/Blender Foundation',
    '/Applications/Blender.app/Contents/MacOS',
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (existsSync(join(root, 'Blender'))) return join(root, 'Blender'); // macOS
    // Windows: the newest "Blender x.y" folder.
    const versions = readdirSync(root).filter((d) => d.startsWith('Blender')).sort().reverse();
    for (const v of versions) {
      const exe = join(root, v, 'blender.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return 'blender';
}

const blender = findBlender();
console.log(`Using ${blender}`);
execFileSync(blender, ['--background', '--factory-startup', '--python', 'art/build_props.py', '--', 'public/models'], { stdio: 'inherit' });
