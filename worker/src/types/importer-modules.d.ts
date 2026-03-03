/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "fast-xml-parser" {
  export class XMLParser {
    constructor(options?: Record<string, unknown>);
    parse(input: string): any;
  }
}

declare module "node-stream-zip" {
  type ZipEntryHandle = unknown;

  type AsyncZip = {
    entryData(name: string): Promise<Buffer>;
    entry(name: string): Promise<ZipEntryHandle>;
    close(): Promise<void>;
  };

  export default class StreamZip {
    static async: new (options: { file: string }) => AsyncZip;
  }
}
