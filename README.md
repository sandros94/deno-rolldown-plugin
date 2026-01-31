# `@deno/rolldown-plugin`

A rolldown and rollup plugin for bundling Deno code.

Still early days and it will probably not work well for npm packages atm (ex.
ESM/CJS interop is not implemented).

1. Discovers your _deno.json_ and _deno.lock_ file.
1. Uses the same code as is used in the Deno CLI, but compiled to Wasm.

## Usage

You must run rolldown via `Deno` or this won't work (running it via Node.js
would require [this issue](https://github.com/dsherret/sys_traits/issues/4) to
be resolved).

1. `deno install npm:rolldown jsr:@deno/rolldown-plugin`
1. Add a `bundle` task to your deno.json file:
   ```jsonc
   {
     "tasks": {
       "bundle": "rolldown -c"
     }
     // ...etc...
   }
   ```
1. Add a `rolldown.config.js` file and specify the Deno plugin. Configure the
   input and output as desired. For example:
   ```js
   import denoPlugin from "@deno/rolldown-plugin";
   import { defineConfig } from "rolldown";

   export default defineConfig({
     input: "./main.js",
     output: {
       file: "bundle.js",
     },
     plugins: denoPlugin(),
   });
   ```
1. Run `deno task bundle`.

## Advanced Usage

### External Dependencies with Deno Specifiers

By default, dependencies marked as `external` in your Rolldown config will use
their bare specifiers (e.g., `"chalk"`, `"@std/assert"`). If you want the
bundled output to use Deno's native `npm:`, `jsr:`, and `https:` import
specifiers instead, enable the `rewriteExternalSpecifiers` option:

```js
import denoPlugin from "@deno/rolldown-plugin";
import { defineConfig } from "rolldown";

export default defineConfig({
  input: "./main.js",
  output: {
    file: "bundle.js",
  },
  external: ["chalk", "@std/assert"], // Mark as external
  plugins: [
    denoPlugin({
      rewriteExternalSpecifiers: true, // Rewrite to Deno specifiers
    }),
  ],
});
```

This will transform imports in the output bundle:

```js
// Before (bare specifiers):
import chalk from "chalk";
import { assertEquals } from "@std/assert";

// After (Deno specifiers):
import chalk from "npm:chalk@5.6.2";
import { assertEquals } from "https://jsr.io/@std/assert/1.0.17/mod.ts";
```

**Benefits:**

- The bundled code can run directly in Deno without additional configuration
- Explicit version pinning from your deno.lock file
- Works with npm, JSR, and HTTPS imports

**Note:** Only dependencies marked in the `external` config will be rewritten.
Bundled dependencies are not affected.
