export type Artifact = {
  artifactId: string;
  mediaType: string;
  data: Uint8Array;
};

export type ArtifactInput = {
  mediaType: string;
  data: Uint8Array;
};

export type ArtifactStore = {
  put(input: ArtifactInput): Promise<string>;
  get(artifactId: string): Promise<Artifact | undefined>;
};

export class InMemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, Artifact>();

  async put({ mediaType, data }: ArtifactInput): Promise<string> {
    if (!mediaType) {
      throw new Error("artifact mediaType is required");
    }
    if (data.byteLength === 0) {
      throw new Error("artifact data must not be empty");
    }

    const artifactId = crypto.randomUUID();
    this.#artifacts.set(artifactId, {
      artifactId,
      mediaType,
      data,
    });
    return artifactId;
  }

  async get(artifactId: string): Promise<Artifact | undefined> {
    return this.#artifacts.get(artifactId);
  }
}

export function createInMemoryArtifactStore(): InMemoryArtifactStore {
  return new InMemoryArtifactStore();
}
