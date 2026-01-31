import {
  type Loader,
  type LoadResponse,
  MediaType,
  RequestedModuleType,
  ResolutionMode,
  Workspace,
  type WorkspaceOptions,
} from "@deno/loader";
import { fromFileUrl } from "@std/path/from-file-url";
import type { ExternalOption, RolldownOptions } from "rolldown";

interface LoaderGraph {
  roots: string[];
  modules: {
    kind: string;
    dependencies: {
      specifier: string;
      code: {
        specifier: string;
        resolutionMode: string;
        span: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
      };
    }[];
    size: number;
    mediaType: string;
    specifier: string;
  }[];
  redirects: Record<string, string>;
  packages: Record<string, string>;
}

interface Module {
  specifier: string;
  code: string;
}

/** Options for creating the Deno plugin. */
export interface DenoPluginOptions extends WorkspaceOptions {
  /**
   * When true, rewrites external imports to use Deno-resolved specifiers
   * (e.g., "chalk" -> "npm:/chalk@5.6.2").
   * Only applies to dependencies marked as external in Rolldown config.
   * @default false
   */
  rewriteExternalSpecifiers?: boolean;
}

export interface BuildStartOptions {
  input: string | string[] | Record<string, string>;
}

export interface ResolveIdOptions {
  kind: "import-statement" | "dynamic-import" | "require-call";
}

export interface RenderChunkOptions {
  format: string;
}

export interface DenoPlugin extends Disposable {
  name: string;
  options(options: RolldownOptions): void;
  buildStart(options: BuildStartOptions): Promise<void>;
  resolveId(
    source: string,
    importer: string | undefined,
    options: ResolveIdOptions,
  ): Promise<string | { id: string; external: boolean }>;
  load(id: string): string | undefined;
  renderChunk(code: string, chunk: RenderChunkOptions): { code: string } | null;
}

/**
 * Creates a deno plugin for use with rolldown or rollup.
 * @returns The plugin.
 */
export default function denoPlugin(
  pluginOptions: DenoPluginOptions = {},
): DenoPlugin {
  let loader: Loader;
  const loads = new Map<string, Promise<LoadResponse | undefined>>();
  const modules = new Map<string, Module | undefined>();
  let rolldownExternal: ExternalOption | undefined = undefined;
  let graph: LoaderGraph | undefined = undefined;

  return {
    name: "deno-plugin",
    [Symbol.dispose]() {
      loader?.[Symbol.dispose]();
    },
    options(options: RolldownOptions) {
      rolldownExternal = options.external;
    },
    async buildStart(options: BuildStartOptions) {
      const inputs = Array.isArray(options.input)
        ? options.input
        : typeof options.input === "object"
        ? Object.values(options.input)
        : [options.input];

      const workspace = new Workspace({
        ...pluginOptions,
      });
      loader = await workspace.createLoader();
      await loader.addEntrypoints(inputs);
      graph = loader.getGraphUnstable() as LoaderGraph;
    },
    async resolveId(
      source: string,
      importer: string | undefined,
      options: ResolveIdOptions,
    ) {
      const resolutionMode = resolveKindToResolutionMode(options.kind);
      importer = importer == null
        ? undefined
        : (modules.get(importer)?.specifier ?? importer);
      const resolvedSpecifier = await loader.resolve(
        source,
        importer,
        resolutionMode,
      );

      // now load
      let loadPromise = loads.get(resolvedSpecifier);
      if (loadPromise == null) {
        loadPromise = loader.load(
          resolvedSpecifier,
          RequestedModuleType.Default,
        );
      }
      const result = await loadPromise;
      if (result == null) {
        modules.set(resolvedSpecifier, undefined);
        return resolvedSpecifier;
      }
      if (result.kind === "external") {
        return {
          id: result.specifier,
          external: true,
        };
      }
      const ext = mediaTypeToExtension(result.mediaType);
      let specifier = result.specifier;
      if (!specifier.endsWith(ext)) {
        specifier += ".rolldown" + ext;
      }
      if (specifier.startsWith("file:///")) {
        // use a path for files so the base gets stripped
        specifier = fromFileUrl(specifier);
      }
      if (pluginOptions.debug && result.specifier !== specifier) {
        console.error("Remapped", result.specifier, "to", specifier);
      }
      modules.set(specifier, {
        specifier: result.specifier,
        code: new TextDecoder().decode(result.code),
      });
      return specifier;
    },
    load(id: string) {
      return modules.get(id)?.code;
    },
    renderChunk(code: string) {
      if (!pluginOptions.rewriteExternalSpecifiers || !graph) return null;

      // Rewrite external imports to use Deno specifiers
      let modifiedCode = code;
      const externalMappings = buildExternalMappings(graph, rolldownExternal);

      if (pluginOptions.debug && externalMappings.size > 0) {
        console.error(
          "External mappings:",
          Array.from(externalMappings.entries()),
        );
      }

      // Replace import/export statements with Deno specifiers
      for (const [bareSpecifier, denoSpecifier] of externalMappings) {
        // Match: import ... from "bareSpecifier" or import ... from 'bareSpecifier'
        // Also match: export ... from "bareSpecifier"
        const importRegex = new RegExp(
          `((?:import|export)(?:[^"']*?)from\\s*["'])${
            escapeRegExp(bareSpecifier)
          }(["'])`,
          "g",
        );
        const dynamicImportRegex = new RegExp(
          `(import\\s*\\(\\s*["'])${escapeRegExp(bareSpecifier)}(["']\\s*\\))`,
          "g",
        );

        modifiedCode = modifiedCode.replace(
          importRegex,
          `$1${denoSpecifier}$2`,
        );
        modifiedCode = modifiedCode.replace(
          dynamicImportRegex,
          `$1${denoSpecifier}$2`,
        );
      }

      return modifiedCode === code ? null : { code: modifiedCode };
    },
  };
}

/**
 * Builds a map of bare specifiers to their Deno-resolved specifiers.
 * This is used in renderChunk to rewrite external imports.
 * Only includes specifiers that match the rolldownExternal configuration.
 */
function buildExternalMappings(
  graph: LoaderGraph,
  rolldownExternal: ExternalOption | undefined,
): Map<string, string> {
  const mappings = new Map<string, string>();

  for (const module of graph.modules) {
    if (module.kind !== "esm" || !module.dependencies) continue;

    for (const dep of module.dependencies) {
      if (!dep.code) continue;

      const bareSpecifier = dep.specifier;
      const denoSpecifier = dep.code.specifier;
      const resolvedSpecifier = graph.redirects[denoSpecifier] ?? denoSpecifier;

      // Skip if resolvedSpecifier is not a string (importing an unknown package)
      if (!resolvedSpecifier || typeof resolvedSpecifier !== "string") continue;

      // Deno's loader returns specifiers as canonical URLs
      const normalizedSpecifier = resolvedSpecifier
        .replace(/^npm:\//, "npm:")
        .replace(/^jsr:\//, "jsr:");

      // Only add if it's an npm/jsr/https import AND matches rolldownExternal
      const isExternalProtocol = normalizedSpecifier.startsWith("npm:") ||
        normalizedSpecifier.startsWith("jsr:") ||
        normalizedSpecifier.startsWith("https:");

      if (
        isExternalProtocol &&
        isMatchingExternal(bareSpecifier, rolldownExternal)
      ) {
        mappings.set(bareSpecifier, normalizedSpecifier);
      }
    }
  }

  return mappings;
}

/**
 * Checks if a specifier matches the rolldown external configuration.
 */
function isMatchingExternal(
  specifier: string,
  external: ExternalOption | undefined,
): boolean {
  if (!external) return false;

  // Handle string
  if (typeof external === "string") {
    return specifier === external;
  }

  // Handle RegExp
  if (external instanceof RegExp) {
    return external.test(specifier);
  }

  // Handle function
  if (typeof external === "function") {
    // Call the function with minimal required args
    // Note: We don't have full context here, so we pass what we can
    return external(specifier, undefined, false) === true;
  }

  // Handle array
  if (Array.isArray(external)) {
    return external.some((ext) => isMatchingExternal(specifier, ext));
  }

  return false;
}

/**
 * Escapes special regex characters in a string.
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mediaTypeToExtension(mediaType: MediaType) {
  switch (mediaType) {
    case MediaType.JavaScript:
      return ".js";
    case MediaType.Mjs:
      return ".mjs";
    case MediaType.Cjs:
      return ".cjs";
    case MediaType.Jsx:
      return ".jsx";
    case MediaType.TypeScript:
    case MediaType.Mts:
      return ".ts";
    case MediaType.Cts:
      return ".cts";
    case MediaType.Dts:
      return ".d.ts";
    case MediaType.Dmts:
      return ".d.mts";
    case MediaType.Dcts:
      return ".d.cts";
    case MediaType.Tsx:
      return ".tsx";
    case MediaType.Css:
      return ".css";
    case MediaType.Json:
      return ".json";
    case MediaType.Html:
      return ".html";
    case MediaType.Sql:
      return ".sql";
    case MediaType.Wasm:
      return ".wasm";
    case MediaType.SourceMap:
      return ".map";
    case MediaType.Unknown:
    default:
      return "";
  }
}

function resolveKindToResolutionMode(kind: string): ResolutionMode {
  switch (kind) {
    case "import-statement":
    case "dynamic-import":
      return ResolutionMode.Import;
    case "require-call":
      return ResolutionMode.Require;
    default:
      throw new Error("not implemented: " + kind);
  }
}
