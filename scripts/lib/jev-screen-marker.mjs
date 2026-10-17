/**
 * Jev PR screen dedupe via GitHub commit status markers.
 *
 * Marker key: (full 40-hex SHA, screener_id, question_set_hash, model)
 * Primary marker: commit status with context "jev-screen", state=success or pending
 * The tier lives in the description field.
 *
 * Reading is fail-safe: re-screen on anything missing, mismatched or from an
 * untrusted author. Writing fails open: a write failure never fails the screen.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const MARKER_CONTEXT = "jev-screen";
export const MARKER_VERSION = "v1";
export const SCREENER_ID = "mjs";
export const ALLOWED_AUTHORS = ["optomachina"];

// Timeout for gh commands
const GH_TIMEOUT_MS = 10000;

/**
 * Hash the question set to detect schema changes.
 */
export function hashQuestions(questions) {
  const canonical = JSON.stringify(questions, Object.keys(questions).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/**
 * Validate a commit SHA (must be 40 hex chars).
 */
export function isValidSha(sha) {
  return typeof sha === "string" && /^[0-9a-f]{40}$/i.test(sha);
}

/**
 * Build marker description from screen result.
 * Format: "v1 tier=<tier> jev=<jev_tier> model=<model> q=<hash> screener=<id>"
 */
export function buildMarkerDescription(tier, jevTier, model, questionHash) {
  return `${MARKER_VERSION} tier=${tier} jev=${jevTier} model=${model} q=${questionHash} screener=${SCREENER_ID}`;
}

/**
 * Parse marker description into components.
 * Returns null if parsing fails or version doesn't match.
 */
export function parseMarkerDescription(description) {
  if (!description || typeof description !== "string") return null;
  
  const parts = description.split(/\s+/);
  if (parts[0] !== MARKER_VERSION) return null;
  
  const parsed = { version: parts[0] };
  for (let i = 1; i < parts.length; i++) {
    const [key, value] = parts[i].split("=");
    if (key && value) parsed[key] = value;
  }
  
  if (!parsed.tier || !parsed.model || !parsed.q || !parsed.screener) return null;
  return parsed;
}

/**
 * Read marker from GitHub for a given SHA.
 * Returns { found: true, tier, jevTier, model, ... } on valid marker hit,
 * or { found: false, reason } on miss.
 *
 * Fail-safe: returns found=false on any error, mismatch or untrusted author.
 */
export async function readMarker(sha, model, questionHash, options = {}) {
  const { owner = "optomachina", repo = "Overdrafter", allowedAuthors = ALLOWED_AUTHORS } = options;
  
  if (!isValidSha(sha)) {
    return { found: false, reason: "invalid_sha" };
  }
  
  let statuses;
  try {
    // GET /repos/{owner}/{repo}/commits/{sha}/statuses
    const output = execFileSync(
      "gh",
      ["api", `repos/${owner}/${repo}/commits/${sha}/statuses`, "--jq", ".[].context,.description,.creator.login,.state"],
      { encoding: "utf8", timeout: GH_TIMEOUT_MS }
    );
    
    const lines = output.trim().split("\n");
    statuses = [];
    for (let i = 0; i < lines.length; i += 4) {
      if (i + 3 < lines.length) {
        statuses.push({
          context: lines[i],
          description: lines[i + 1],
          creator: lines[i + 2],
          state: lines[i + 3]
        });
      }
    }
  } catch (error) {
    return { found: false, reason: "api_error", error: String(error.message || error) };
  }
  
  // Filter for our context
  const markers = statuses.filter(s => s.context === MARKER_CONTEXT);
  if (markers.length === 0) {
    return { found: false, reason: "no_marker" };
  }
  
  // Find valid markers (trusted author, matching model/questions, success or pending state)
  const validMarkers = [];
  for (const marker of markers) {
    // Check author
    if (!allowedAuthors.includes(marker.creator)) {
      continue;
    }
    
    // Parse description
    const parsed = parseMarkerDescription(marker.description);
    if (!parsed) continue;
    
    // Check model and question hash match
    if (parsed.model !== model || parsed.q !== questionHash) {
      continue;
    }
    
    // Check screener
    if (parsed.screener !== SCREENER_ID) {
      continue;
    }
    
    // Only accept success states for cache hits
    if (marker.state === "success") {
      validMarkers.push({
        tier: parsed.tier,
        jevTier: parsed.jev || null,
        model: parsed.model,
        questionHash: parsed.q,
        screener: parsed.screener
      });
    }
  }
  
  if (validMarkers.length === 0) {
    return { found: false, reason: "no_valid_marker" };
  }
  
  // If multiple valid markers, take the highest tier
  const tiers = ["low", "normal", "risky"];
  const highestMarker = validMarkers.reduce((max, current) => {
    const maxIdx = tiers.indexOf(max.tier);
    const curIdx = tiers.indexOf(current.tier);
    return curIdx > maxIdx ? current : max;
  });
  
  return {
    found: true,
    ...highestMarker
  };
}

/**
 * Write marker to GitHub for a given SHA.
 * Returns { success: true } or { success: false, reason }.
 *
 * Fail-open: a write failure is logged but does not fail the screen.
 */
export async function writeMarker(sha, tier, jevTier, model, questionHash, options = {}) {
  const { owner = "optomachina", repo = "Overdrafter", state = "success", pending = false } = options;
  
  if (!isValidSha(sha)) {
    return { success: false, reason: "invalid_sha" };
  }
  
  const actualState = pending ? "pending" : state;
  const description = buildMarkerDescription(tier, jevTier || tier, model, questionHash);
  
  try {
    // POST /repos/{owner}/{repo}/statuses/{sha}
    execFileSync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/statuses/${sha}`,
        "-X", "POST",
        "-f", `state=${actualState}`,
        "-f", `description=${description}`,
        "-f", `context=${MARKER_CONTEXT}`
      ],
      { encoding: "utf8", timeout: GH_TIMEOUT_MS }
    );
    
    return { success: true };
  } catch (error) {
    return { success: false, reason: "api_error", error: String(error.message || error) };
  }
}

/**
 * Optional: claim a pending marker to signal work in progress.
 * Returns { success: true } or { success: false, reason }.
 */
export async function claimPendingMarker(sha, caller, model, questionHash, options = {}) {
  const { owner = "optomachina", repo = "Overdrafter" } = options;
  
  if (!isValidSha(sha)) {
    return { success: false, reason: "invalid_sha" };
  }
  
  const timestamp = new Date().toISOString();
  const description = `${MARKER_VERSION} claim by=${caller} at=${timestamp} model=${model} q=${questionHash}`;
  
  try {
    execFileSync(
      "gh",
      [
        "api",
        `repos/${owner}/${repo}/statuses/${sha}`,
        "-X", "POST",
        "-f", "state=pending",
        "-f", `description=${description}`,
        "-f", `context=${MARKER_CONTEXT}`
      ],
      { encoding: "utf8", timeout: GH_TIMEOUT_MS }
    );
    
    return { success: true };
  } catch (error) {
    return { success: false, reason: "api_error", error: String(error.message || error) };
  }
}

/**
 * Wait for a pending marker to complete (optional optimization).
 * Polls for up to maxWaitMs, returns { found: true, ... } if completed,
 * or { found: false, reason: "timeout" } if still pending.
 */
export async function waitForPendingMarker(sha, model, questionHash, options = {}) {
  const { maxWaitMs = 30000, pollIntervalMs = 2000, ...readOptions } = options;
  
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    const result = await readMarker(sha, model, questionHash, readOptions);
    
    if (result.found) {
      return result;
    }
    
    // Check if there's a recent pending claim
    let statuses;
    try {
      const output = execFileSync(
        "gh",
        ["api", `repos/${readOptions.owner || "optomachina"}/${readOptions.repo || "Overdrafter"}/commits/${sha}/statuses`, "--jq", ".[].context,.description,.state,.updated_at"],
        { encoding: "utf8", timeout: GH_TIMEOUT_MS }
      );
      
      const lines = output.trim().split("\n");
      statuses = [];
      for (let i = 0; i < lines.length; i += 4) {
        if (i + 3 < lines.length) {
          statuses.push({
            context: lines[i],
            description: lines[i + 1],
            state: lines[i + 2],
            updated_at: lines[i + 3]
          });
        }
      }
    } catch {
      // On error, give up waiting
      return { found: false, reason: "api_error" };
    }
    
    const pendingMarkers = statuses.filter(
      s => s.context === MARKER_CONTEXT && s.state === "pending"
    );
    
    if (pendingMarkers.length === 0) {
      // No pending claim, stop waiting
      return { found: false, reason: "no_pending_claim" };
    }
    
    // Check if the pending claim is recent (< 60s old)
    const newestPending = pendingMarkers[0];
    const claimAge = Date.now() - new Date(newestPending.updated_at).getTime();
    if (claimAge > 60000) {
      // Claim is stale, stop waiting
      return { found: false, reason: "stale_claim" };
    }
    
    // Wait and poll again
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  
  return { found: false, reason: "timeout" };
}
