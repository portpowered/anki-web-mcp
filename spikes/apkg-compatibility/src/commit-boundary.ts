import type {
  NormalizedStagedResult,
  ParserTerminalMessage,
} from "./protocol";

export type StagedCommit = (result: NormalizedStagedResult) => void;

/**
 * The only hand-off into a downstream repository. Non-success terminal
 * messages deliberately have no value that can reach the callback.
 */
export function commitIfReady(
  terminal: ParserTerminalMessage,
  commit: StagedCommit,
): boolean {
  if (
    terminal.status !== "success" ||
    terminal.commitReady !== true ||
    terminal.stagedResult === null
  ) {
    return false;
  }

  commit(terminal.stagedResult);
  return true;
}
