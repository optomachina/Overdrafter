import { launchOptions as camoufoxLaunchOptions } from "camoufox-js";
import { VirtualDisplay } from "camoufox-js/dist/virtdisplay.js";
import { firefox, type BrowserContext } from "playwright";

const CONFIG_PREFIX = "CAMOU_CONFIG_";
const CONFIG_CHUNK_BYTES = 32_767;

function readGeneratedConfig(options: Record<string, unknown>): Record<string, unknown> {
  const env = (options.env ?? {}) as Record<string, string>;
  const encoded = Object.entries(env)
    .filter(([key]) => key.startsWith(CONFIG_PREFIX))
    .sort(([left], [right]) => Number(left.slice(CONFIG_PREFIX.length)) - Number(right.slice(CONFIG_PREFIX.length)))
    .map(([, value]) => value)
    .join("");
  const parsed = JSON.parse(encoded) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Camoufox did not produce a valid launch identity.");
  }
  return parsed as Record<string, unknown>;
}

function pinGeneratedConfig(
  options: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const env = { ...((options.env ?? {}) as Record<string, string>) };
  for (const key of Object.keys(env)) {
    if (key.startsWith(CONFIG_PREFIX)) delete env[key];
  }
  const encoded = JSON.stringify(config);
  for (let offset = 0, index = 1; offset < encoded.length; offset += CONFIG_CHUNK_BYTES, index += 1) {
    env[`${CONFIG_PREFIX}${index}`] = encoded.slice(offset, offset + CONFIG_CHUNK_BYTES);
  }
  return { ...options, env };
}

/** Launch a persistent Camoufox context with one exact generated fingerprint configuration. */
export async function launchPersistentCamoufox(input: {
  userDataDir: string;
  headless: boolean;
  identityConfig?: Record<string, unknown>;
  launchOverrides?: Record<string, unknown>;
}) {
  const virtualDisplay = input.headless ? new VirtualDisplay(false) : null;
  try {
    const generatedOptions = await camoufoxLaunchOptions({
      config: input.identityConfig ?? {},
      headless: false,
      window: [1366, 900],
      humanize: true,
      geoip: true,
      virtual_display: virtualDisplay?.get(),
      ...input.launchOverrides,
    });
    const identityConfig = input.identityConfig ?? readGeneratedConfig(generatedOptions);
    const context = (await firefox.launchPersistentContext(
      input.userDataDir,
      pinGeneratedConfig(generatedOptions, identityConfig),
    )) as BrowserContext;
    const originalClose = context.close.bind(context);
    context.close = async (...args) => {
      try {
        await originalClose(...args);
      } finally {
        virtualDisplay?.kill();
      }
    };
    return { context, identityConfig };
  } catch (error) {
    virtualDisplay?.kill();
    throw error;
  }
}
