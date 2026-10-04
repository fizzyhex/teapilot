import { copyFile, mkdir, rm } from 'node:fs/promises';

const destination = new URL('../dist/art/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['typing', 'pawing', 'tea-break']) {
  await copyFile(new URL(`../src/art/ascii-${name}.json`, import.meta.url), new URL(`ascii-${name}.json`, destination));
}
const templates = new URL('../dist/workspace/template/', import.meta.url);
await mkdir(templates, { recursive: true });
for (const name of ['AGENTS.txt', 'README.txt', 'legacy-README.txt']) {
  await copyFile(new URL(`../src/workspace/template/${name}`, import.meta.url), new URL(name, templates));
}
// Remove only artifacts from the retired baked-in snapshot on incremental builds.
for (const name of ['snapshot.json', 'LICENSE', 'discord-play', 'thoughtful-planner']) {
  await rm(new URL(`../dist/skills/${name}`, import.meta.url), { recursive: true, force: true });
}
