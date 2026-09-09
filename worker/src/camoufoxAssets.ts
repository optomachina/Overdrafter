import fs from "node:fs";
import path from "node:path";
import { INSTALL_DIR, OS_NAME } from "camoufox-js/dist/pkgman.js";

const INVALID_ASSETS = "Camoufox pinned assets are unavailable or invalid; run the reviewed installer before launch.";

/**
 * Reject incomplete or mismatched cache assets before Camoufox can enter its
 * implicit downloader. Reads only; does not repair caches or authorize a launch.
 * This preflight assumes no concurrent cache mutation by the same OS user.
 */
export function assertCamoufoxAssetsPresent(
  root = String(INSTALL_DIR),
  platform: "lin" | "mac" | "win" = OS_NAME,
): void {
  try {
    const check = (relative: string, directory = false) => {
      const pieces = relative.split("/").filter(Boolean);
      let current = root;
      const rootStat = fs.lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(INVALID_ASSETS);
      for (const [index, piece] of pieces.entries()) {
        current = path.join(current, piece);
        const stat = fs.lstatSync(current);
        const needsDirectory = index < pieces.length - 1 || directory;
        if (stat.isSymbolicLink() || (needsDirectory && !stat.isDirectory()) || (!needsDirectory && !stat.isFile())) {
          throw new Error(INVALID_ASSETS);
        }
      }
      return current;
    };
    let resources = "";
    let executable = "camoufox-bin";
    if (platform === "mac") {
      resources = "Camoufox.app/Contents/Resources/";
      executable = "Camoufox.app/Contents/MacOS/camoufox";
    } else if (platform === "win") {
      executable = "camoufox.exe";
    }
    const version = JSON.parse(fs.readFileSync(check("version.json"), "utf8"));
    if (version?.version !== "152.0.4" || version?.release !== "beta.28") throw new Error(INVALID_ASSETS);
    const launcher = check(executable);
    if (platform !== "win" && !(fs.statSync(launcher).mode & 0o111)) throw new Error(INVALID_ASSETS);
    check(`${resources}properties.json`);
    const addon = JSON.parse(fs.readFileSync(check(`${resources}addons/UBO/manifest.json`), "utf8"));
    if (addon?.version !== "1.73.0") throw new Error(INVALID_ASSETS);
  } catch {
    // Never expose cache paths, manifest content or raw filesystem errors.
    throw new Error(INVALID_ASSETS);
  }
}
