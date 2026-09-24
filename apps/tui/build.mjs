import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import solid from "babel-preset-solid";
import typescript from "@babel/preset-typescript";

const sourceDirectory = resolve("src");
const outputDirectory = resolve("dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const sourceFiles = await findSourceFiles(sourceDirectory);

for (const sourceFile of sourceFiles.sort()) {
  const inputPath = join(sourceDirectory, sourceFile);
  const outputPath = join(
    outputDirectory,
    sourceFile.replace(/\.tsx$/, ".js").replace(/\.ts$/, ".js"),
  );
  const result = await transformAsync(await readFile(inputPath, "utf8"), {
    filename: inputPath,
    sourceType: "module",
    configFile: false,
    babelrc: false,
    sourceMaps: true,
    presets: [
      [solid, { moduleName: "@opentui/solid", generate: "universal" }],
      [typescript, { isTSX: sourceFile.endsWith(".tsx"), allExtensions: true }],
    ],
  });
  if (!result?.code) {
    throw new Error(`Babel produced no output for ${sourceFile}`);
  }
  const code = result.code
    .replace(/(from\s+["'])solid-js(["'])/g, "$1solid-js/dist/solid.js$2")
    .replace(/(from\s+["'])solid-js\/store(["'])/g, "$1solid-js/store/dist/store.js$2");

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${code}\n//# sourceMappingURL=${`${sourceFile.replace(/\.tsx?$/, ".js")}.map`}\n`,
  );
  await writeFile(
    `${outputPath}.map`,
    JSON.stringify({
      version: 3,
      sources: [relative(outputDirectory, inputPath)],
      names: result.map?.names ?? [],
      mappings: result.map?.mappings ?? "",
    }),
  );
}

async function findSourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...(await findSourceFiles(join(directory, entry.name))).map(
        (file) => `${entry.name}/${file}`,
      ));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(entry.name);
    }
  }
  return files;
}
