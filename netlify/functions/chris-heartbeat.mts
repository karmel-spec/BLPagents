/**
 * SCHEDULED. Reports Chris healthy from this cloud runtime once the GrokBot
 * bridge env is set. Before that, this is a no-op so the Mac heartbeat is
 * still the only signal. Chris has no crons; the Shop Manager Briefing is
 * the Store Map script, not a job on this function.
 */
import { grokbotConfigured } from "../../src/lib/chris-bridge";
import { saveHeartbeat } from "../../src/lib/agent-health";

export default async () => {
  if (!grokbotConfigured()) {
    return new Response(JSON.stringify({ ok: true, skipped: "CHRIS_GROKBOT_WEBHOOK_URL / CHRIS_GROKBOT_WEBHOOK_KEY not set" }), { headers: { "content-type": "application/json" } });
  }
  const agents = await saveHeartbeat({
    machine: "Cristofori GrokBot (cloud)",
    agents: [{ slug: "chris", online: true, crons: [], note: "Cristofori GrokBot bridge" }],
  });
  return new Response(JSON.stringify({ ok: true, agents }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "*/10 * * * *" };
