/** Supabase REST (service key, server-only) for the console's chat threads and jobs. Same project the Store Map chat writes (agent_messages). */
const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const supaConfigured = () => Boolean(URL_BASE && KEY);

export async function supa<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!supaConfigured()) throw new Error("Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)");
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "content-type": "application/json", Prefer: "return=representation", ...(init.headers || {}) },
    signal: AbortSignal.timeout(12000),
    cache: "no-store",
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${init.method || "GET"} ${r.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}
