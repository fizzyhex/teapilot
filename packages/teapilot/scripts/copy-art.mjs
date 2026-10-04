import { copyFile, mkdir, rm } from 'node:fs/promises';

const destination = new URL('../dist/art/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['typing', 'pawing', 'tea-break']) {
  await copyFile(new URL(`../src/art/ascii-${name}.json`, import.meta.url), new URL(`ascii-${name}.json`, destination));
}
// Remove only artifacts from the retired baked-in snapshot on incremental builds.
for (const name of ['snapshot.json', 'LICENSE', 'discord-play', 'thoughtful-planner']) {
  await rm(new URL(`../dist/skills/${name}`, import.meta.url), { recursive: true, force: true });
}
