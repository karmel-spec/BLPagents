/**
 * Which agents run on Grok Bot rather than Hermes.
 * Keep the runtime test in step with isGrokBotRuntime in src/lib/agents.ts.
 *
 * GROK_BOT_SLUGS is the fallback when a Mac copy of agent-registry.json
 * still says Hermes. Melody moved to Grok Bot; the team reaches her on
 * Telegram (https://t.me/melodylarsonbot), not through the Mac gateway.
 */
import fs from "node:fs";
import path from "node:path";

export const GROK_BOT_SLUGS = new Set(["melody"]);

export function isGrokBotRuntime(runtime) {
  return /^\s*grok\s*bot\b/i.test(String(runtime || ""));
}

export function grokBotSlugsFromRegistry(registry) {
  const slugs = new Set(GROK_BOT_SLUGS);
  for (const agent of registry || []) {
    if (agent && agent.slug && isGrokBotRuntime(agent.runtime)) slugs.add(agent.slug);
  }
  return slugs;
}

export function registryCandidates(home, scriptDir) {
  return [
    path.join(home, "salesapp2", "src", "lib", "agent-registry.json"),
    path.join(home, "blp", "agent-registry.json"),
    path.join(scriptDir, "..", "src", "lib", "agent-registry.json"),
  ];
}

/** First readable registry, or null. A torn file is skipped. */
export function readRegistry(candidates) {
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`skip registry ${file}: ${e.message}`);
    }
  }
  return null;
}
