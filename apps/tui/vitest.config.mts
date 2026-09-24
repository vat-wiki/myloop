import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";
import typescript from "@babel/preset-typescript";
import { defineConfig } from "vitest/config";

function resolveSolidRuntimeImport(specifier: string): string {
  if (specifier === "solid-js") return "solid-js/dist/solid.js";
  if (specifier === "solid-js/store") return "solid-js/store/dist/store.js";
  return specifier;
}

export default defineConfig({
  plugins: [
    {
      name: "opentui-solid",
      enforce: "pre",
      async transform(code, id) {
        if (id.includes("/node_modules/") || !/\.[cm]?[jt]sx?$/.test(id)) return null;
        const result = await transformAsync(code, {
          filename: id,
          sourceType: "module",
          configFile: false,
          babelrc: false,
          sourceMaps: true,
          presets: [
            [solid, { moduleName: "@opentui/solid", generate: "universal" }],
            [typescript, { isTSX: id.endsWith(".tsx"), allExtensions: true }],
          ],
        });
        if (!result?.code) return null;
        const output = result.code.replace(
          /(from\s+["'])(solid-js(?:\/store)?)(["'])/g,
          (_, prefix: string, specifier: string, suffix: string) =>
            `${prefix}${resolveSolidRuntimeImport(specifier)}${suffix}`,
        );
        return { code: output, map: result.map ?? null };
      },
    },
  ],
  test: {
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--experimental-ffi"],
      },
    },
  },
});
