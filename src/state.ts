import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir as defaultStateDir } from "./paths.js";
import type { TurnState } from "./types.js";

function stateName(sessionKey: string): string {
  return `${createHash("sha256").update(sessionKey).digest("hex")}.json`;
}

export class TurnStateStore {
  readonly directory: string;

  constructor(directory = defaultStateDir()) {
    this.directory = directory;
  }

  private pathFor(sessionKey: string): string {
    return join(this.directory, stateName(sessionKey));
  }

  async save(state: TurnState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.pathFor(state.sessionKey);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  }

  async load(sessionKey: string): Promise<TurnState | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.pathFor(sessionKey), "utf8")) as TurnState;
      if (
        parsed.version !== 1 ||
        parsed.sessionKey !== sessionKey ||
        typeof parsed.messageId !== "string"
      ) {
        throw new Error("turn state is invalid");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async remove(sessionKey: string): Promise<void> {
    await rm(this.pathFor(sessionKey), { force: true });
  }
}
