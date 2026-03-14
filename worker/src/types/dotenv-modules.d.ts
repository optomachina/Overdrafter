declare module "dotenv" {
  export type DotenvConfigOutput = {
    parsed?: Record<string, string>;
    error?: Error;
  };

  export type DotenvConfigOptions = {
    path?: string;
    encoding?: string;
    debug?: boolean;
    override?: boolean;
    processEnv?: Record<string, string | undefined>;
  };

  export function config(options?: DotenvConfigOptions): DotenvConfigOutput;
}

declare module "dotenv/config";
