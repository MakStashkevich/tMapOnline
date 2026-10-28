import { readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as sass from 'sass';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(projectRoot, 'terraria_viewer', 'web', 'src');
const assetRoot = join(projectRoot, 'terraria_viewer', 'web', 'assets');
const styleRoot = join(sourceRoot, 'styles', 'entries');

await rm(assetRoot, { recursive: true, force: true });
await mkdir(assetRoot, { recursive: true });

await build({
  entryPoints: {
    'app-shell': join(sourceRoot, 'app-shell.ts'),
    'world-map': join(sourceRoot, 'map', 'world-map.ts'),
  },
  outdir: assetRoot,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['safari15'],
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'info',
});

const compileStyle = async (source, output) => {
  const result = await sass.compileAsync(source, { style: 'compressed', sourceMap: false });
  const destination = join(assetRoot, output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, result.css);
};

await compileStyle(join(styleRoot, 'app-shell.scss'), 'app-shell.css');
await compileStyle(join(styleRoot, 'world-map.scss'), 'world-map.css');
const sectionEntries = join(styleRoot, 'sections');
for (const name of (await readdir(sectionEntries)).filter((file) => file.endsWith('.scss'))) {
  await compileStyle(join(sectionEntries, name), `sections/${name.replace(/\.scss$/, '.css')}`);
}
console.log('Web assets built: minified ESM and CSS; section code and styles remain lazy-loaded.');
