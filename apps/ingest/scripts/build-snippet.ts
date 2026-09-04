import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

/**
 * Builds the tracking snippet.
 *
 * The source lives in `src/snippet/pulse.src.js` with full comments; what gets
 * served is the minified `public/pulse.js`. It is committed to the repo so a
 * clean clone can serve it without a build step, and the size budget is
 * enforced here rather than trusted — a snippet that silently grows past a
 * couple of kilobytes stops being something a customer will put in their
 * <head>.
 */
const BUDGET_BYTES = 2048;

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, '../src/snippet/pulse.src.js');
const outFile = path.join(here, '../public/pulse.js');

async function main(): Promise<void> {
  await mkdir(path.dirname(outFile), { recursive: true });

  const result = await build({
    entryPoints: [source],
    outfile: outFile,
    bundle: false,
    minify: true,
    // ES5 so the snippet runs everywhere, including the old browsers whose
    // traffic customers most want to know about.
    target: ['es5'],
    format: 'iife',
    legalComments: 'none',
    banner: { js: '/* Pulse analytics — cookieless. https://github.com/pulse-analytics */' },
    write: true,
  });

  if (result.errors.length > 0) {
    throw new Error(`esbuild reported ${result.errors.length} error(s)`);
  }

  const output = await readFile(outFile);
  const gzipped = gzipSync(output).length;

  // eslint-disable-next-line no-console
  console.log(
    `pulse.js: ${output.byteLength} bytes raw, ${gzipped} bytes gzipped (budget ${BUDGET_BYTES})`,
  );

  if (output.byteLength > BUDGET_BYTES) {
    throw new Error(
      `Snippet is ${output.byteLength} bytes, over the ${BUDGET_BYTES}-byte budget. ` +
        'Trim it rather than raising the budget.',
    );
  }

  // Sanity check: the public API must survive minification.
  const text = output.toString('utf8');
  for (const symbol of ['pulse', 'track', 'sendBeacon', '/collect']) {
    if (!text.includes(symbol)) {
      throw new Error(`Minified snippet is missing "${symbol}" — the build mangled the public API`);
    }
  }

  await writeFile(`${outFile}.meta.json`, JSON.stringify({ bytes: output.byteLength, gzipped }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
