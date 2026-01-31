import denoPlugin from "./mod.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

Deno.test("should load and resolve", async () => {
  const plugin = denoPlugin({
    noTranspile: true,
  });
  await plugin.buildStart({
    input: import.meta.url,
  });
  {
    const value = (await plugin.resolveId("./mod.ts", import.meta.url, {
      kind: "import-statement",
    })) as string;
    assertEquals(value, fromFileUrl(import.meta.resolve("./mod.ts")));
    const text = await plugin.load(value);
    assertEquals(text, Deno.readTextFileSync(value));
  }
  // node specifier
  {
    const value = await plugin.resolveId("node:events", import.meta.url, {
      kind: "import-statement",
    });
    if (typeof value === "string") {
      throw new Error("Fail.");
    }
    assertEquals(value.external, true);
    assertEquals(value.id, "node:events");
  }
});

Deno.test("renderChunk", async (t) => {
  await t.step(
    "should not rewrite when feature is disabled (default)",
    async () => {
      using plugin = denoPlugin();

      const { tempDir, testFile } = await prepareFiles({
        code: 'import chalk from "chalk";\nconsole.log("test");',
        imports: {
          "chalk": "npm:chalk@^5.3.0",
        },
      });

      plugin.options({ external: "chalk" });
      await plugin.buildStart({ input: testFile });

      const inputCode = `import e from"chalk";console.log("test");`;
      const result = plugin.renderChunk(inputCode, { format: "es" });

      // Should return null when feature is disabled
      assertEquals(result, null);

      await Deno.remove(tempDir, { recursive: true });
    },
  );

  await t.step("should rewrite with string external", async () => {
    const { tempDir, denoJson, testFile } = await prepareFiles({
      code: 'import chalk from "chalk";\nconsole.log("test");',
      imports: {
        "chalk": "npm:chalk@^5.3.0",
      },
    });

    using plugin = denoPlugin({
      rewriteExternalSpecifiers: true,
      configPath: denoJson,
    });

    plugin.options({ external: "chalk" });
    await plugin.buildStart({ input: testFile });

    const inputCode = `import e from"chalk";console.log("test");`;
    const result = plugin.renderChunk(inputCode, { format: "es" });

    // Should rewrite chalk to npm: specifier
    assertEquals(
      result !== null,
      true,
      "Result should not be null when rewriting is enabled",
    );
    assertStringIncludes(result!.code, "npm:");
    assertStringIncludes(result!.code, "chalk");
    assertEquals(
      result!.code.includes('from"chalk"'),
      false,
      "Should not contain bare 'chalk' import",
    );

    await Deno.remove(tempDir, { recursive: true });
  });

  await t.step("should rewrite with array external", async () => {
    const { tempDir, denoJson, testFile } = await prepareFiles({
      code:
        'import chalk from "chalk";\nimport { assertEquals } from "@std/assert";\nconsole.log("test");',
      imports: {
        "chalk": "npm:chalk@^5.3.0",
        "@std/assert": "jsr:@std/assert@^1.0.0",
      },
    });

    using plugin = denoPlugin({
      rewriteExternalSpecifiers: true,
      configPath: denoJson,
    });

    plugin.options({ external: ["chalk", "@std/assert"] });
    await plugin.buildStart({ input: testFile });

    const inputCode =
      `import e from"chalk";import{assertEquals as t}from"@std/assert";console.log("test");`;
    const result = plugin.renderChunk(inputCode, { format: "es" });

    assertEquals(
      result !== null,
      true,
      "Result should not be null when rewriting is enabled",
    );
    // Should contain npm: for chalk
    assertStringIncludes(result!.code, "npm:");
    // Should contain jsr: or https://jsr.io for @std/assert
    const hasJsr = result!.code.includes("jsr:") ||
      result!.code.includes("https://jsr.io");
    assertEquals(hasJsr, true, "Should contain JSR specifier");

    await Deno.remove(tempDir, { recursive: true });
  });

  await t.step("should rewrite with regex external", async () => {
    const { tempDir, denoJson, testFile } = await prepareFiles({
      code:
        'import chalk from "chalk";\nimport { assertEquals } from "@std/assert";\nconsole.log("test");',
      imports: {
        "chalk": "npm:chalk@^5.3.0",
        "@std/assert": "jsr:@std/assert@^1.0.0",
      },
    });

    using plugin = denoPlugin({
      rewriteExternalSpecifiers: true,
      configPath: denoJson,
    });

    plugin.options({ external: /^(chalk|@std\/)/ });
    await plugin.buildStart({ input: testFile });

    const inputCode =
      `import e from"chalk";import{assertEquals as t}from"@std/assert";console.log("test");`;
    const result = plugin.renderChunk(inputCode, { format: "es" });

    assertEquals(
      result !== null,
      true,
      "Result should not be null when rewriting is enabled",
    );
    const hasNpmOrJsr = result!.code.includes("npm:") ||
      result!.code.includes("jsr:") ||
      result!.code.includes("https://jsr.io");
    assertEquals(hasNpmOrJsr, true, "Should contain npm: or jsr: specifiers");

    await Deno.remove(tempDir, { recursive: true });
  });

  await t.step("should only rewrite matching externals", async () => {
    const { tempDir, denoJson, testFile } = await prepareFiles({
      code:
        'import chalk from "chalk";\nimport { assertEquals } from "@std/assert";\nconsole.log("test");',
      imports: {
        "chalk": "npm:chalk@^5.3.0",
        "@std/assert": "jsr:@std/assert@^1.0.0",
      },
    });

    using plugin = denoPlugin({
      rewriteExternalSpecifiers: true,
      configPath: denoJson,
    });

    // Only mark chalk as external, not @std/assert
    plugin.options({ external: "chalk" });
    await plugin.buildStart({ input: testFile });

    const inputCode =
      `import e from"chalk";import{assertEquals as t}from"@std/assert";console.log("test");`;
    const result = plugin.renderChunk(inputCode, { format: "es" });

    assertEquals(
      result !== null,
      true,
      "Result should not be null when rewriting is enabled",
    );
    // Should rewrite chalk
    assertStringIncludes(result!.code, "npm:");
    assertStringIncludes(result!.code, "chalk");

    // @std/assert should NOT be rewritten since it's not in external config
    // Rolldown will in fact bundle it, but at this stage we just check that the import remains unchanged
    assertEquals(
      result!.code.includes('from"@std/assert"'),
      true,
      "Should still contain bare '@std/assert' import",
    );
    assertEquals(
      result!.code.includes("jsr:@std/assert"),
      false,
      "Should NOT contain rewritten JSR specifier",
    );

    await Deno.remove(tempDir, { recursive: true });
  });

  await t.step("should handle dynamic imports", async () => {
    const { tempDir, denoJson, testFile } = await prepareFiles({
      code: 'import("chalk").then(m=>console.log(m));',
      imports: {
        "chalk": "npm:chalk@^5.3.0",
      },
    });

    using plugin = denoPlugin({
      rewriteExternalSpecifiers: true,
      configPath: denoJson,
    });

    plugin.options({ external: "chalk" });
    await plugin.buildStart({ input: testFile });

    const inputCode = `import("chalk").then(m=>console.log(m));`;
    const result = plugin.renderChunk(inputCode, { format: "es" });

    assertEquals(
      result !== null,
      true,
      "Result should not be null when rewriting is enabled",
    );
    // Dynamic import should also be rewritten
    assertStringIncludes(result!.code, 'import("npm:');
    assertStringIncludes(result!.code, "chalk");

    await Deno.remove(tempDir, { recursive: true });
  });

  await t.step("should preserve code when no externals match", async () => {
    using plugin = denoPlugin({
      rewriteExternalSpecifiers: true,
    });

    const { tempDir, testFile } = await prepareFiles({
      code: 'console.log("test");',
      imports: {},
    });

    plugin.options({ external: "nonexistent-package" });
    await plugin.buildStart({ input: testFile });

    const inputCode = `console.log("test");`;
    const result = plugin.renderChunk(inputCode, { format: "es" });

    // Should return null when no rewrites are needed
    assertEquals(result, null);

    await Deno.remove(tempDir, { recursive: true });
  });

  await t.step("should handle export statements", async () => {
    const { tempDir, denoJson, testFile } = await prepareFiles({
      code: 'export { assertEquals } from "@std/assert";',
      imports: {
        "@std/assert": "jsr:@std/assert@^1.0.0",
      },
    });

    using plugin = denoPlugin({
      rewriteExternalSpecifiers: true,
      configPath: denoJson,
    });

    plugin.options({ external: "@std/assert" });
    await plugin.buildStart({ input: testFile });

    const inputCode = `export{assertEquals as e}from"@std/assert";`;
    const result = plugin.renderChunk(inputCode, { format: "es" });

    assertEquals(
      result !== null,
      true,
      "Result should not be null when rewriting is enabled",
    );
    // Export statement should also be rewritten
    const hasJsr = result!.code.includes("jsr:") ||
      result!.code.includes("https://jsr.io");
    assertEquals(hasJsr, true, "Should rewrite export from statement");

    await Deno.remove(tempDir, { recursive: true });
  });
});

async function prepareFiles(
  input: { code: string; imports: Record<string, string> },
) {
  const tempDir = await Deno.makeTempDir();
  const denoJson = join(tempDir, "deno.json");
  const testFile = join(tempDir, "test.ts");

  await Promise.all([
    Deno.writeTextFile(
      denoJson,
      JSON.stringify({ imports: input.imports }),
    ),
    Deno.writeTextFile(
      testFile,
      input.code,
    ),
  ]);

  return { tempDir, denoJson, testFile };
}
