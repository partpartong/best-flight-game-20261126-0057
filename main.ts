// Ridge Runner — the hand-in program.
//
// Copies the playable game (game/) and its screenshots (screenshots/)
// from this repository to the output directory and writes
// /output/dossier.json with buildDossier from vendor/makefun-game.ts.
//
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The program is deterministic: it copies the same files in the same
// order every run, and the dossier is written from those files alone, so
// two runs write identical bytes.

import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The repository root is the directory this file lives in, wherever the
// grader puts it; the output directory is /output, or MAKEFUN_OUTPUT_DIR.
const repoRoot = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });

// Copy a directory tree in sorted order, so the output is the same on
// every run even if the filesystem lists entries differently.
function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src).sort()) {
    const from = join(src, name);
    const to = join(dst, name);
    if (statSync(from).isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

// Copy the whole game and its screenshots, in sorted order, so the
// output is the same on every run.
for (const name of ['game', 'screenshots']) {
  copyTree(join(repoRoot, name), join(outDir, name));
}

// The gate's caps, from the competition's gate.json: 160 KiB of dossier
// text, at most 4 screenshots of 256 KiB each, at most 993 game entries
// totalling 48 MiB, and paths of at most 1,000 bytes.
const dossier = buildDossier(outDir, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

// Report what was handed in, so a run's output says plainly whether the
// game, its screenshots and the dossier all made it out.
const shots = readdirSync(join(outDir, 'screenshots')).sort();
const gameFiles = readdirSync(join(outDir, 'game')).sort();
console.log(`Ridge Runner: wrote ${outDir}/dossier.json (${dossier.length} bytes)`);
console.log(`game/: ${gameFiles.join(', ')}`);
console.log(`screenshots/: ${shots.join(', ')}`);
