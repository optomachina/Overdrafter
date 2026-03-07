import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const sourceLogoPath = path.join(rootDir, "src", "assets", "logo.png");
const publicDir = path.join(rootDir, "public");

const pngOutputs = [
  { size: 16, fileName: "favicon-16x16.png" },
  { size: 32, fileName: "favicon-32x32.png" },
  { size: 48, fileName: "favicon-48x48.png" },
  { size: 180, fileName: "apple-touch-icon.png" },
];

function ensurePrerequisites() {
  if (!fs.existsSync(sourceLogoPath)) {
    throw new Error(`Source logo not found at ${sourceLogoPath}`);
  }

  try {
    execFileSync("sips", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("The favicon generator requires the macOS `sips` command.");
  }

  fs.mkdirSync(publicDir, { recursive: true });
}

function resizePng({ size, fileName }) {
  const outputPath = path.join(publicDir, fileName);
  execFileSync(
    "sips",
    ["-z", String(size), String(size), sourceLogoPath, "--out", outputPath],
    { stdio: "ignore" },
  );
  return outputPath;
}

function writeIco(targetPath, pngPaths) {
  const pngBuffers = pngPaths.map((pngPath) => fs.readFileSync(pngPath));
  const iconCount = pngBuffers.length;
  const headerSize = 6;
  const directoryEntrySize = 16;
  const directorySize = iconCount * directoryEntrySize;

  let offset = headerSize + directorySize;
  const directoryEntries = pngBuffers.map((buffer, index) => {
    const size = pngOutputs[index].size;
    const width = size >= 256 ? 0 : size;
    const height = size >= 256 ? 0 : size;
    const entry = Buffer.alloc(directoryEntrySize);

    entry.writeUInt8(width, 0);
    entry.writeUInt8(height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);

    offset += buffer.length;
    return entry;
  });

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(iconCount, 4);

  fs.writeFileSync(targetPath, Buffer.concat([header, ...directoryEntries, ...pngBuffers]));
}

function main() {
  ensurePrerequisites();

  const generatedPngs = pngOutputs.map(resizePng);
  writeIco(path.join(publicDir, "favicon.ico"), generatedPngs.slice(0, 3));

  console.log("Generated favicon assets:");
  console.log(`- ${path.relative(rootDir, path.join(publicDir, "favicon.ico"))}`);
  for (const outputPath of generatedPngs) {
    console.log(`- ${path.relative(rootDir, outputPath)}`);
  }
}

main();
