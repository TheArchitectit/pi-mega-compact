/**
 * get-state-dir.ts — extracted `MegaRuntime.getStateDir()` (S21). A one-liner
 * in its own module per the maximal-split convention: no method bodies left in
 * runtime.ts.
 */

// ---------------------------------------------------------------------- types

/** The slice of `MegaRuntime` getStateDir reads. */
export interface GetStateDirContext {
	readonly currentStateDir: string;
}

// --------------------------------------------------------------- getStateDir

/** S21: state dir of the currently bound repo (where memories live). */
export function getStateDirImpl(self: GetStateDirContext): string {
	return self.currentStateDir;
}
