// Tiny argument parser: `--name value`, `--name=value`, bare `--flag`. A bare `--` (pnpm passes it through) is ignored.
export type Args = { flags: Set<string>; values: Map<string, string>; rest: string[] };

export function parseArgs(argv: string[], valueOptions: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (!a.startsWith("--")) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (valueOptions.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      values.set(name, v);
    } else {
      flags.add(name);
    }
  }
  return { flags, values, rest };
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Runs a script's main function: prints UsageError / Error messages without a stack and sets the exit code. */
export async function runMain(main: () => Promise<number | void>): Promise<void> {
  try {
    const code = await main();
    if (typeof code === "number" && code !== 0) process.exitCode = code;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    if (!(e instanceof UsageError) && process.env.NT_DEBUG && e instanceof Error) console.error(e.stack);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
