import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditTool } from "../../src/core/tools/edit.ts";

describe("edit tool error hints", () => {
	let testDir: string;
	const editTool = () => createEditTool(testDir);

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-edit-hints-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("names the line numbers of a duplicate match", async () => {
		const path = join(testDir, "duplicate.txt");
		writeFileSync(path, "keep\nsame\nkeep\nsame\nsame\n");

		await expect(editTool().execute("dup", { path, edits: [{ oldText: "same", newText: "other" }] })).rejects.toThrow(
			"Found 3 occurrences of the text in",
		);
		await expect(editTool().execute("dup", { path, edits: [{ oldText: "same", newText: "other" }] })).rejects.toThrow(
			"(lines 2, 4, 5)",
		);
	});

	it("stops the duplicate line list at five and marks that more exist", async () => {
		const path = join(testDir, "many.txt");
		writeFileSync(path, `${Array.from({ length: 7 }, () => "same").join("\n")}\n`);

		await expect(
			editTool().execute("many", { path, edits: [{ oldText: "same", newText: "other" }] }),
		).rejects.toThrow("Found 7 occurrences of the text in");
		await expect(
			editTool().execute("many", { path, edits: [{ oldText: "same", newText: "other" }] }),
		).rejects.toThrow("(lines 1, 2, 3, 4, 5, ...)");
	});

	it("accepts a trailing-space difference without a retry", async () => {
		const path = join(testDir, "trailing.txt");
		writeFileSync(path, "alpha\nbeta   \ngamma\n");

		const result = await editTool().execute("trailing", {
			path,
			edits: [{ oldText: "alpha\nbeta", newText: "ALPHA\nBETA" }],
		});

		// The fuzzy match leaves the trailing spaces of the unchanged line in place.
		expect(readFileSync(path, "utf-8")).toBe("ALPHA\nBETA   \ngamma\n");
		expect(result.isError).toBeUndefined();
	});

	it("names the nearest lines when the text does not match", async () => {
		const path = join(testDir, "nearest.txt");
		writeFileSync(
			path,
			["# header", "const value = 41;", "# other", "const value = 42x;", "# tail", "const value = 43;"].join("\n"),
		);

		let message = "";
		await editTool()
			.execute("nearest", { path, edits: [{ oldText: "const value = 42;", newText: "const value = 0;" }] })
			.catch((error: Error) => {
				message = error.message;
			});

		expect(message).toContain("Could not find the exact text");
		expect(message).toContain("Nearest lines:");
		const lines = message.split("\n").filter((line) => /^\s+\d+: /.test(line));
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThanOrEqual(3);
		for (const line of lines) {
			expect(line.slice(line.indexOf(": ") + 2).length).toBeLessThanOrEqual(120);
		}
		// The closest line to the requested text is the one that differs by one character.
		expect(message).toContain("4: const value = 42x;");
	});

	it("bounds a long nearest-line snippet to 120 characters", async () => {
		const path = join(testDir, "long.txt");
		const longLine = `const value = ${"x".repeat(300)}`;
		writeFileSync(path, `${longLine}\n`);

		let message = "";
		await editTool()
			.execute("long", { path, edits: [{ oldText: "const value = yyy;", newText: "short" }] })
			.catch((error: Error) => {
				message = error.message;
			});

		const hint = message.split("\n").find((line) => /^\s+1: /.test(line));
		expect(hint).toBeDefined();
		const snippet = hint!.slice(hint!.indexOf(": ") + 2);
		expect(snippet.length).toBeLessThanOrEqual(120);
		expect(snippet.endsWith("...")).toBe(true);
	});
});
