/** Minimal surface of archiver v8 (ESM named exports) used by the content tools. */
declare module "archiver" {
  export class Archiver {
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    append(data: Buffer, options: { name: string }): this;
    finalize(): Promise<void>;
  }
  export class ZipArchive extends Archiver {
    constructor(options?: { zlib?: { level?: number } });
  }
}
