/** Registry of agents with scheduled-task modules, so routes and schedulers stay agent-agnostic. */
import type { Job } from "./agent-brain";

export interface TaskModule {
  AGENT: string;
  TASKS: Record<string, { id: string; title: string; times: { hour: number; minute: number }[]; days: number[]; summary: string }>;
  startTask: (taskId: string, requestedBy: string) => Promise<Job | null>;
  schedulePaused: () => boolean;
}

export async function taskModule(slug: string): Promise<TaskModule | null> {
  if (slug === "arnold") return (await import("./arnold-tasks")) as unknown as TaskModule;
  if (slug === "clara") return (await import("./clara-tasks")) as unknown as TaskModule;
  return null;
}
