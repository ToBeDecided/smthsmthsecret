// Loads the extension's classic scripts into an isolated context, the way
// the browser does, and returns their shared LMC namespace.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../../extension/', import.meta.url));

export function loadExtension(files, globals = {}) {
  const ctx = vm.createContext({
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  for (const f of files) vm.runInContext(readFileSync(EXT + f, 'utf8'), ctx, { filename: f });
  return ctx.LMC;
}

// Objects from another realm fail strict deep-equality on prototype checks.
export const plain = (x) => JSON.parse(JSON.stringify(x));
