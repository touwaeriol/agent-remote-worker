// Bundles each role into one self-contained file. The plugin runs dist/master.js;
// dist/worker.js is what the master copies to a worker, so it must need nothing else.
import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  legalComments: "none",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};

await build({ ...shared, entryPoints: ["src/master/main.ts"], outfile: "dist/master.js" });
await build({ ...shared, entryPoints: ["src/worker/main.ts"], outfile: "dist/worker.js" });
