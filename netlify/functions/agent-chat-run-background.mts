/**
 * BACKGROUND function (up to 15 min): runs one agent job — a console chat,
 * a Telegram turn (reply goes back through the Bot API) or one of Arnold's
 * scheduled tasks — and stores the result in agent_jobs (+ agent_messages). Triggered by the console's
 * /api/agents/[slug]/chat with the team key.
 *   POST {jobId}   header x-blp-key: BLP_APP_ACCESS_KEY
 */
import { runJob } from "../../src/lib/agent-brain";
import "../../src/lib/arnold-tasks"; // registers the "task" job runner

export default async (req: Request) => {
  const key = process.env.BLP_APP_ACCESS_KEY || "";
  if (key && req.headers.get("x-blp-key") !== key) return new Response("forbidden", { status: 403 });
  const { jobId } = (await req.json().catch(() => ({}))) as { jobId?: number };
  if (!jobId) return new Response("jobId required", { status: 400 });
  await runJob(Number(jobId));
  return new Response("ok");
};
