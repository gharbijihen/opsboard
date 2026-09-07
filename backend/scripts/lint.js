import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOTS = ['src', 'scripts', 'test', 'load', '../frontend'];
const CHECK_EXTENSIONS = new Set(['.js', '.css', '.html', '.json']);
const JS_EXTENSIONS = new Set(['.js']);

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(path));
    } else if (CHECK_EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

function runSyntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    throw new Error(`${file}\n${result.stderr || result.stdout}`);
  }
}

const files = (await Promise.all(ROOTS.map(listFiles))).flat();
const failures = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    if (/\s+$/.test(line)) {
      failures.push(`${file}:${index + 1} has trailing whitespace`);
    }
    if (line.includes('\t')) {
      failures.push(`${file}:${index + 1} uses a tab character`);
    }
  });

  if (JS_EXTENSIONS.has(extname(file))) {
    try {
      runSyntaxCheck(file);
    } catch (error) {
      failures.push(error.message);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`lint passed for ${files.length} files`);
