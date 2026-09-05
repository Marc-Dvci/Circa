import { CaseService, configureRepository } from "#store";
import { DemoProviderRepository, type ProviderRepository } from "#providers";

/**
 * What a tool handler is allowed to reach.
 *
 * Deliberately small. A tool gets the case service, the provider directory, a
 * clock and a place to record how long it took — and no HTTP request, no
 * session, no transport. That is what makes the same fourteen handlers usable
 * from the CLI and the simulator without a second implementation, and it is why
 * `pnpm demo` exercises the code path the MCP server exercises rather than an
 * approximation of it.
 */
export interface ServerContext {
  service: CaseService;
  providers: ProviderRepository;
  metrics: Metrics;
  clock: () => string;
  /** Who the case belongs to. Supplied by the auth layer when there is one. */
  userId: string;
}

export interface ToolTiming {
  tool: string;
  ms: number;
  at: string;
  ok: boolean;
}

/**
 * Latency, recorded per call.
 *
 * Alexa+ gives an add-on a budget measured in hundreds of milliseconds, and a
 * published target that nobody measures is a wish. Every call is timed, `pnpm
 * bench` prints p50 and p95 per tool, and the numbers in the README come from
 * that command rather than from an impression.
 */
export class Metrics {
  private readonly timings: ToolTiming[] = [];

  record(timing: ToolTiming): void {
    this.timings.push(timing);
    if (this.timings.length > 5000) this.timings.splice(0, 1000);
  }

  all(): readonly ToolTiming[] {
    return this.timings;
  }

  summary(): { tool: string; calls: number; p50: number; p95: number; max: number; errors: number }[] {
    const byTool = new Map<string, ToolTiming[]>();
    for (const timing of this.timings) {
      const list = byTool.get(timing.tool) ?? [];
      list.push(timing);
      byTool.set(timing.tool, list);
    }
    return [...byTool.entries()]
      .map(([tool, list]) => {
        const sorted = [...list].map((t) => t.ms).sort((a, b) => a - b);
        return {
          tool,
          calls: list.length,
          p50: quantile(sorted, 0.5),
          p95: quantile(sorted, 0.95),
          max: sorted.at(-1) ?? 0,
          errors: list.filter((t) => !t.ok).length,
        };
      })
      .sort((a, b) => b.p95 - a.p95);
  }
}

/** Nearest-rank. With twenty samples a p95 that interpolates is inventing a number. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, rank)] ?? 0;
}

export async function createContext(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ServerContext> = {},
): Promise<ServerContext> {
  const repository = overrides.service ? undefined : await configureRepository(env);
  return {
    service: overrides.service ?? new CaseService(repository!),
    providers: overrides.providers ?? new DemoProviderRepository(),
    metrics: overrides.metrics ?? new Metrics(),
    clock: overrides.clock ?? (() => new Date().toISOString()),
    userId: overrides.userId ?? env["CIRCA_USER"] ?? "user_demo",
  };
}
