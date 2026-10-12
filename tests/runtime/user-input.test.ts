import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUserInputAdapter } from "../../src/runtime/user-input.js";
import { createInMemoryArtifactStore, InMemoryArtifactStore } from "../../src/runtime/artifacts.js";
import { textBlock } from "../../src/runtime/messages.js";

describe("createUserInputAdapter", () => {
  const temporaryDirectories: Array<string> = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("normalizes text, standard blocks and explicit input parts", async () => {
    const adapter = createUserInputAdapter();
    const result = await adapter.resolve([
      "analyze this",
      textBlock("standard text"),
      { type: "imageUrl", url: "https://example.com/image.png" },
      { type: "documentUrl", url: "https://example.com/report.pdf", title: "Report" },
    ]);

    expect(result).toEqual([
      { type: "text", text: "analyze this" },
      { type: "text", text: "standard text" },
      {
        type: "image",
        mediaType: "image/png",
        source: { type: "url", url: "https://example.com/image.png" },
      },
      {
        type: "document",
        mediaType: "application/pdf",
        title: "Report",
        source: { type: "url", url: "https://example.com/report.pdf" },
      },
    ]);
  });

  it("allows local files by default and rejects them when explicitly disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myloop-input-default-"));
    temporaryDirectories.push(directory);
    const imagePath = join(directory, "image.png");
    await writeFile(imagePath, "image");
    const defaultAdapter = createUserInputAdapter();
    const [image] = await defaultAdapter.resolve({ type: "imageFile", path: imagePath });
    expect(image).toMatchObject({
      type: "image",
      mediaType: "image/png",
      source: { type: "artifact" },
    });

    const disabledAdapter = createUserInputAdapter({ allowLocalFiles: false });
    await expect(disabledAdapter.resolve({
      type: "imageFile",
      path: imagePath,
    })).rejects.toThrow("local input files are not allowed");
  });

  it("uses a default artifact store for allowed local files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myloop-input-"));
    temporaryDirectories.push(directory);
    const imagePath = join(directory, "image.png");
    const documentPath = join(directory, "report.pdf");
    await writeFile(imagePath, "image");
    await writeFile(documentPath, "document");

    const adapter = createUserInputAdapter({ allowLocalFiles: true });
    expect(adapter.artifactStore).toBeInstanceOf(InMemoryArtifactStore);

    const [image] = await adapter.resolve([{ type: "imageFile", path: imagePath }]);
    expect(image).toMatchObject({
      type: "image",
      mediaType: "image/png",
      source: { type: "artifact" },
    });
  });

  it("stores allowed local files as artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myloop-artifact-"));
    temporaryDirectories.push(directory);
    const imagePath = join(directory, "image.png");
    const documentPath = join(directory, "report.pdf");
    await writeFile(imagePath, "image");
    await writeFile(documentPath, "document");
    const artifactStore = createInMemoryArtifactStore();
    const adapter = createUserInputAdapter({
      allowLocalFiles: true,
      artifactStore,
    });

    const [image, document] = await adapter.resolve([
      { type: "imageFile", path: imagePath },
      { type: "documentFile", path: documentPath },
    ]);

    expect(image).toMatchObject({ type: "image", mediaType: "image/png" });
    expect(document).toMatchObject({ type: "document", mediaType: "application/pdf" });
    expect(image).toHaveProperty("source.type", "artifact");
    expect(document).toHaveProperty("source.type", "artifact");
  });

  it("enforces remote and local file policies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myloop-input-policy-"));
    temporaryDirectories.push(directory);
    const largePath = join(directory, "large.png");
    await writeFile(largePath, "12345");
    const adapter = createUserInputAdapter({
      allowLocalFiles: true,
      allowRemoteUrls: false,
      maxLocalFileBytes: 4,
      artifactStore: createInMemoryArtifactStore(),
    });

    await expect(adapter.resolve({
      type: "imageUrl",
      url: "https://example.com/image.png",
    })).rejects.toThrow("remote input urls are not allowed");
    await expect(adapter.resolve({
      type: "imageFile",
      path: largePath,
    })).rejects.toThrow("input file exceeds maxLocalFileBytes");
  });

  it("enforces the total input byte budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "myloop-input-total-"));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, "first.png");
    const secondPath = join(directory, "second.png");
    await writeFile(firstPath, "12345");
    await writeFile(secondPath, "12345");
    const adapter = createUserInputAdapter({
      allowLocalFiles: true,
      artifactStore: createInMemoryArtifactStore(),
      maxTotalInputBytes: 8,
    });

    await expect(adapter.resolve([
      { type: "imageFile", path: firstPath },
      { type: "imageFile", path: secondPath },
    ])).rejects.toThrow("input exceeds maxTotalInputBytes: 8");
  });
});
