/** Temp directories for tests, all deleted when the test file finishes. */
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const created: string[] = [];

after(() => {
	for (const dir of created) {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Creates a private (0700) temp directory. */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
	created.push(dir);
	return dir;
}
