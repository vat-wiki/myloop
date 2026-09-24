import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type {
  BinarySource,
  ImageMediaType,
  UserContentBlock,
} from "./messages.js";
import { InMemoryArtifactStore, type ArtifactStore } from "./artifacts.js";

const DEFAULT_MAX_LOCAL_FILE_BYTES = 20 * 1024 * 1024;

const IMAGE_MEDIA_TYPES = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
} as const satisfies Record<string, ImageMediaType>;

type NormalizedUserInput = {
  block: UserContentBlock;
  bytes: number;
};

export type UserInputAdapterOptions = {
  allowLocalFiles?: boolean;
  allowRemoteUrls?: boolean;
  maxLocalFileBytes?: number;
  maxTotalInputBytes?: number;
  artifactStore?: ArtifactStore;
};

export type UserInputPart =
  | { type: "text"; text: string }
  | { type: "imageFile"; path: string; mediaType?: ImageMediaType }
  | { type: "documentFile"; path: string; title?: string }
  | { type: "imageUrl"; url: string; mediaType?: ImageMediaType }
  | { type: "documentUrl"; url: string; title?: string };

export type UserInput =
  | string
  | UserContentBlock
  | UserInputPart
  | ReadonlyArray<string | UserContentBlock | UserInputPart>;

export type UserInputResolver = {
  readonly artifactStore: ArtifactStore;
  resolve(input: UserInput): Promise<Array<UserContentBlock>>;
};

export function isUserInputAdapter(
  value: UserInputResolver | UserInputAdapterOptions | undefined,
): value is UserInputResolver {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return "resolve" in value && typeof value.resolve === "function";
}

export function createUserInputAdapter(
  options: UserInputAdapterOptions = {},
): UserInputResolver {
  const resolvedOptions = {
    allowLocalFiles: options.allowLocalFiles ?? false,
    allowRemoteUrls: options.allowRemoteUrls ?? true,
    maxLocalFileBytes: options.maxLocalFileBytes ?? DEFAULT_MAX_LOCAL_FILE_BYTES,
    maxTotalInputBytes: options.maxTotalInputBytes ?? DEFAULT_MAX_LOCAL_FILE_BYTES,
    artifactStore: options.artifactStore ?? new InMemoryArtifactStore(),
  };

  if (!Number.isInteger(resolvedOptions.maxLocalFileBytes) || resolvedOptions.maxLocalFileBytes < 1) {
    throw new Error("maxLocalFileBytes must be a positive integer");
  }
  if (!Number.isInteger(resolvedOptions.maxTotalInputBytes) || resolvedOptions.maxTotalInputBytes < 1) {
    throw new Error("maxTotalInputBytes must be a positive integer");
  }
  return {
    artifactStore: resolvedOptions.artifactStore,
    async resolve(input: UserInput): Promise<Array<UserContentBlock>> {
      const items = typeof input === "string" || !Array.isArray(input) ? [input] : input;
      const blocks: Array<UserContentBlock> = [];
      let totalBytes = 0;
      for (const item of items) {
        const normalized = await resolveItem(item, resolvedOptions);
        totalBytes += normalized.bytes;
        if (totalBytes > resolvedOptions.maxTotalInputBytes) {
          throw new Error(`input exceeds maxTotalInputBytes: ${resolvedOptions.maxTotalInputBytes}`);
        }
        blocks.push(normalized.block);
      }
      return blocks;
    },
  };
}

async function resolveItem(
  item: string | UserContentBlock | UserInputPart,
  options: {
    allowLocalFiles: boolean;
    allowRemoteUrls: boolean;
    maxLocalFileBytes: number;
    artifactStore?: ArtifactStore;
  },
): Promise<NormalizedUserInput> {
  if (typeof item === "string") {
    return { block: { type: "text", text: item }, bytes: 0 };
  }

  if (item.type === "text") {
    return { block: item, bytes: 0 };
  }

  if (item.type === "image" || item.type === "document" || item.type === "video") {
    if (item.source.type === "url") {
      assertRemoteUrlsAllowed(options.allowRemoteUrls);
    }
    return { block: item, bytes: measureInputBytes(item) };
  }

  switch (item.type) {
    case "imageFile":
      {
        const { source, bytes } = await readLocalFile(
          item.path,
          imageMediaTypeFromPath(item.path),
          options,
        );
        return {
          block: {
            type: "image",
            mediaType: item.mediaType ?? imageMediaTypeFromPath(item.path),
            source,
          },
          bytes,
        };
      }
    case "documentFile":
      {
        assertPdfPath(item.path);
        const { source, bytes } = await readLocalFile(item.path, "application/pdf", options);
        return {
          block: {
            type: "document",
            mediaType: "application/pdf",
            title: item.title ?? basename(item.path),
            source,
          },
          bytes,
        };
      }
    case "imageUrl":
      return {
        block: {
          type: "image",
          mediaType: item.mediaType ?? imageMediaTypeFromUrl(item.url),
          source: remoteSource(item.url, options),
        },
        bytes: 0,
      };
    case "documentUrl":
      return {
        block: {
          type: "document",
          mediaType: "application/pdf",
          title: item.title,
          source: remoteSource(item.url, options),
        },
        bytes: 0,
      };
  }
}

function remoteSource(url: string, options: { allowRemoteUrls: boolean }): BinarySource {
  assertRemoteUrlsAllowed(options.allowRemoteUrls);
  assertHttpUrl(url);
  return { type: "url", url };
}

async function readLocalFile(
  filePath: string,
  mediaType: string,
  options: { allowLocalFiles: boolean; maxLocalFileBytes: number; artifactStore?: ArtifactStore },
): Promise<{ source: BinarySource; bytes: number }> {
  if (!options.allowLocalFiles) {
    throw new Error("local input files are not allowed");
  }
  if (!options.artifactStore) {
    throw new Error("local file input requires an artifactStore");
  }

  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`input file is not a regular file: ${filePath}`);
  }
  if (info.size > options.maxLocalFileBytes) {
    throw new Error(`input file exceeds maxLocalFileBytes: ${filePath}`);
  }

  const data = await readFile(filePath);
  return {
    source: {
      type: "artifact",
      artifactId: await options.artifactStore.put({ mediaType, data }),
    },
    bytes: info.size,
  };
}

function measureInputBytes(block: UserContentBlock): number {
  if (block.type !== "image" && block.type !== "document" && block.type !== "video") {
    return 0;
  }
  if (block.source.type === "base64") {
    return Math.floor(block.source.data.length * 3 / 4);
  }
  return 0;
}

function assertRemoteUrlsAllowed(allowRemoteUrls: boolean): void {
  if (!allowRemoteUrls) {
    throw new Error("remote input urls are not allowed");
  }
}

function assertHttpUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported input url protocol: ${parsed.protocol}`);
  }
}

function imageMediaTypeFromPath(filePath: string): ImageMediaType {
  const mediaType = IMAGE_MEDIA_TYPES[extname(filePath).toLowerCase() as keyof typeof IMAGE_MEDIA_TYPES];
  if (!mediaType) {
    throw new Error(`unsupported local image file type: ${filePath}`);
  }
  return mediaType;
}

function imageMediaTypeFromUrl(url: string): ImageMediaType {
  const pathname = new URL(url).pathname;
  const mediaType = IMAGE_MEDIA_TYPES[extname(pathname).toLowerCase() as keyof typeof IMAGE_MEDIA_TYPES];
  if (!mediaType) {
    throw new Error(`unable to infer image media type from url: ${url}`);
  }
  return mediaType;
}

function assertPdfPath(filePath: string): void {
  if (extname(filePath).toLowerCase() !== ".pdf") {
    throw new Error(`unsupported local document file type: ${filePath}`);
  }
}
