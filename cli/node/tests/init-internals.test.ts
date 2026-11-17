/**
 * Unit tests for init internals — decision tree primitives + plugin sync.
 *
 * Mirror of `cli/python/tests/test_init_internals.py`. Both files MUST stay
 * in sync — if you add a behavioral assertion here, mirror it on the Python
 * side and vice versa.
 *
 *  - `pingKey` must NOT treat network errors as "invalid key" (else a VPN
 *    flap silently mints a new shadow over a working key).
 *  - `plugin_sync` must only update entries that already exist, preserve
 *    trailing newlines, never mangle other lines, and write through a
 *    symlinked file instead of replacing the link.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type TestContext,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { pingKey } from "../src/commands/init.js";
import { updateClaudeSettings, updateShellRc } from "../src/plugin-sync.js";

/** Creating a symlink needs a privilege on Windows; skip there rather than fail. */
function symlinkOrSkip(ctx: TestContext, target: string, link: string): void {
	try {
		fs.symlinkSync(target, link);
	} catch (err) {
		ctx.skip(`symlinks unavailable: ${(err as Error).message}`);
	}
}

// ── pingKey ──────────────────────────────────────────────────────────────

describe("pingKey — network vs auth distinction", () => {
	const origFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = origFetch;
		vi.restoreAllMocks();
	});

	it("returns true for 200", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 } as Response);
		await expect(pingKey("k", "http://x")).resolves.toBe(true);
	});

	it("returns false for 401 (definitively invalid)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ status: 401 } as Response);
		await expect(pingKey("k", "http://x")).resolves.toBe(false);
	});

	it("returns false for 403 (definitively invalid)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ status: 403 } as Response);
		await expect(pingKey("k", "http://x")).resolves.toBe(false);
	});

	it("returns true for 5xx (transient upstream — prefer reuse)", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ status: 503 } as Response);
		await expect(pingKey("k", "http://x")).resolves.toBe(true);
	});

	it("returns true on network error (prefer reuse over re-mint)", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(pingKey("k", "http://x")).resolves.toBe(true);
	});

	it("returns true on timeout (prefer reuse)", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("aborted"));
		await expect(pingKey("k", "http://x")).resolves.toBe(true);
	});
});

// ── updateShellRc ────────────────────────────────────────────────────────

describe("updateShellRc — exists-only contract", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-test-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("updates existing export and preserves trailing newline", () => {
		const rc = path.join(tmpDir, ".zshrc");
		fs.writeFileSync(rc, 'export MEM0_API_KEY="old"\n');
		expect(updateShellRc(rc, "newkey")).toBe(true);
		expect(fs.readFileSync(rc, "utf-8")).toBe('export MEM0_API_KEY="newkey"\n');
	});

	it("does NOT create a new export when none exists", () => {
		const rc = path.join(tmpDir, ".zshrc");
		fs.writeFileSync(rc, "alias ll='ls -la'\n");
		expect(updateShellRc(rc, "newkey")).toBe(false);
		expect(fs.readFileSync(rc, "utf-8")).toBe("alias ll='ls -la'\n");
	});

	it("preserves surrounding content", () => {
		const rc = path.join(tmpDir, ".zshrc");
		const original =
			"# my zshrc\n" +
			"alias ll='ls -la'\n" +
			"export MEM0_API_KEY='old'\n" +
			"export OTHER=keepme\n";
		fs.writeFileSync(rc, original);
		updateShellRc(rc, "newkey");
		const after = fs.readFileSync(rc, "utf-8");
		expect(after).toContain("alias ll='ls -la'\n");
		expect(after).toContain("export OTHER=keepme\n");
		expect(after).toContain("# my zshrc\n");
		expect(after).toContain('export MEM0_API_KEY="newkey"\n');
	});

	it("is idempotent when value already matches", () => {
		const rc = path.join(tmpDir, ".zshrc");
		fs.writeFileSync(rc, 'export MEM0_API_KEY="same"\n');
		expect(updateShellRc(rc, "same")).toBe(false);
	});

	it("is a no-op for missing files", () => {
		const rc = path.join(tmpDir, ".zshrc"); // does not exist
		expect(updateShellRc(rc, "x")).toBe(false);
	});

	it("keeps a symlinked rc file a symlink and updates its target", (ctx) => {
		// Dotfile managers (GNU Stow, chezmoi, yadm) symlink ~/.zshrc into a repo.
		const dotfiles = path.join(tmpDir, "dotfiles");
		fs.mkdirSync(dotfiles);
		const real = path.join(dotfiles, "zshrc");
		fs.writeFileSync(real, '# managed\nexport MEM0_API_KEY="old"\n');
		const rc = path.join(tmpDir, ".zshrc");
		symlinkOrSkip(ctx, path.join("dotfiles", "zshrc"), rc);

		expect(updateShellRc(rc, "newkey")).toBe(true);

		expect(fs.lstatSync(rc).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(rc)).toBe(path.join("dotfiles", "zshrc"));
		expect(fs.readFileSync(real, "utf-8")).toBe(
			'# managed\nexport MEM0_API_KEY="newkey"\n',
		);
		expect(fs.readdirSync(dotfiles)).toEqual(["zshrc"]); // no temp file left
	});

	it("leaves a dangling symlink alone", (ctx) => {
		const rc = path.join(tmpDir, ".zshrc");
		symlinkOrSkip(ctx, path.join("dotfiles", "zshrc"), rc); // target does not exist

		expect(updateShellRc(rc, "newkey")).toBe(false);

		expect(fs.lstatSync(rc).isSymbolicLink()).toBe(true);
		expect(fs.existsSync(path.join(tmpDir, "dotfiles"))).toBe(false);
	});
});

// ── updateClaudeSettings ─────────────────────────────────────────────────

describe("updateClaudeSettings — never creates entries", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mem0-test-"));
	});
	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("does not create env block when none exists", () => {
		const settings = path.join(tmpDir, "settings.json");
		fs.writeFileSync(settings, JSON.stringify({ otherKey: 1 }));
		expect(updateClaudeSettings(settings, "newkey")).toBe(false);
		expect(JSON.parse(fs.readFileSync(settings, "utf-8"))).toEqual({
			otherKey: 1,
		});
	});

	it("does not create MEM0_API_KEY entry in existing env block", () => {
		const settings = path.join(tmpDir, "settings.json");
		fs.writeFileSync(settings, JSON.stringify({ env: { OTHER_KEY: "x" } }));
		expect(updateClaudeSettings(settings, "newkey")).toBe(false);
	});

	it("updates existing entry and preserves siblings", () => {
		const settings = path.join(tmpDir, "settings.json");
		fs.writeFileSync(
			settings,
			JSON.stringify({ env: { MEM0_API_KEY: "old", OTHER: "y" } }, null, 2),
		);
		expect(updateClaudeSettings(settings, "fresh")).toBe(true);
		const data = JSON.parse(fs.readFileSync(settings, "utf-8"));
		expect(data.env.MEM0_API_KEY).toBe("fresh");
		expect(data.env.OTHER).toBe("y");
	});

	it("keeps a symlinked settings.json a symlink and updates its target", (ctx) => {
		const dotfiles = path.join(tmpDir, "dotfiles");
		fs.mkdirSync(dotfiles);
		const real = path.join(dotfiles, "claude-settings.json");
		fs.writeFileSync(
			real,
			JSON.stringify({ env: { MEM0_API_KEY: "old", OTHER: "y" } }, null, 2),
		);
		fs.chmodSync(real, 0o600);
		const modeBefore = fs.statSync(real).mode & 0o777;
		const claudeDir = path.join(tmpDir, ".claude");
		fs.mkdirSync(claudeDir);
		const settings = path.join(claudeDir, "settings.json");
		const linkTarget = path.join("..", "dotfiles", "claude-settings.json");
		symlinkOrSkip(ctx, linkTarget, settings);

		expect(updateClaudeSettings(settings, "fresh")).toBe(true);

		expect(fs.lstatSync(settings).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(settings)).toBe(linkTarget);
		const data = JSON.parse(fs.readFileSync(real, "utf-8"));
		expect(data.env).toEqual({ MEM0_API_KEY: "fresh", OTHER: "y" });
		expect(fs.statSync(real).mode & 0o777).toBe(modeBefore);
		expect(fs.readdirSync(dotfiles)).toEqual(["claude-settings.json"]);
	});

	it("is idempotent when value already matches", () => {
		const settings = path.join(tmpDir, "settings.json");
		fs.writeFileSync(
			settings,
			JSON.stringify({ env: { MEM0_API_KEY: "same" } }),
		);
		expect(updateClaudeSettings(settings, "same")).toBe(false);
	});

	it("is a no-op for malformed JSON", () => {
		const settings = path.join(tmpDir, "settings.json");
		fs.writeFileSync(settings, "{ this is not json");
		expect(updateClaudeSettings(settings, "x")).toBe(false);
	});
});
