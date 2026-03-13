#!/usr/bin/env tsx

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isCancel, select } from "@clack/prompts";
import { Command } from "commander";

interface VersionParts {
	major: number;
	minor: number;
	patch: number;
}

interface PrereleaseInfo {
	type: "alpha" | "beta" | "rc" | "stable";
	number: number;
}

// Parse version from package.json
function getCurrentVersion(): string {
	const packagePath = path.join(process.cwd(), "package.json");
	const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
	return packageJson.version;
}

// Parse version into components
function parseVersion(version: string): VersionParts {
	const baseVersion = version.replace(/-.*$/, "");
	const [major, minor, patch] = baseVersion.split(".").map(Number);
	return { major, minor, patch };
}

// Check if version is a prerelease
function isPrerelease(version: string): boolean {
	return /-/.test(version);
}

// Extract prerelease type
function getPrereleaseType(version: string): PrereleaseInfo["type"] {
	const match = version.match(/-([a-z]+)/);
	return (match?.[1] as PrereleaseInfo["type"]) || "stable";
}

// Extract prerelease number
function getPrereleaseNumber(version: string): number {
	const match = version.match(/-([a-z]+)\.(\d+)/);
	return match ? Number(match[2]) : 0;
}

// Get next prerelease level
function getNextPrereleaseLevel(
	current: PrereleaseInfo["type"],
): PrereleaseInfo["type"] {
	const levels: Record<PrereleaseInfo["type"], PrereleaseInfo["type"]> = {
		alpha: "beta",
		beta: "rc",
		rc: "stable",
		stable: "alpha",
	};
	return levels[current];
}

// Validate semantic version format
function validateVersion(version: string): { valid: boolean; error?: string } {
	// Format: x.y.z or x.y.z-prerelease.n
	const versionRegex =
		/^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*)?$/;

	if (!versionRegex.test(version)) {
		return {
			valid: false,
			error: `Invalid version format: "${version}". Expected format: x.y.z or x.y.z-prerelease.n`,
		};
	}

	return { valid: true };
}

// Get manual version input from user
async function selectManualVersion(): Promise<string> {
	const { text } = await import("@clack/prompts");

	let version = "";
	let isValid = false;

	while (!isValid) {
		const input = await text({
			message: "Enter version (e.g., 1.0.0 or 1.0.0-alpha.1):",
			validate: (value) => {
				const validation = validateVersion(value ?? "");
				if (!validation.valid) {
					return validation.error;
				}
				return undefined;
			},
		});

		if (isCancel(input)) {
			console.log("Released cancelled");
			process.exit(0);
		}

		const validation = validateVersion(input);
		if (validation.valid) {
			version = input;
			isValid = true;
		}
	}

	return version;
}

// Create new version based on bump type
function createVersion(current: string, bumpType: string): string {
	const parts = parseVersion(current);
	const type = getPrereleaseType(current);
	const number = getPrereleaseNumber(current);
	const baseVersion = current.replace(/-.*$/, "");

	switch (bumpType) {
		case "patch":
			return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
		case "minor":
			return `${parts.major}.${parts.minor + 1}.0`;
		case "major":
			return `${parts.major + 1}.0.0`;
		case "increment-prerelease":
			return `${baseVersion}-${type}.${number + 1}`;
		case "next-prerelease": {
			const nextLevel = getNextPrereleaseLevel(type);
			return nextLevel === "stable"
				? baseVersion
				: `${baseVersion}-${nextLevel}.1`;
		}
		case "alpha-to-rc":
			return `${baseVersion}-rc.1`;
		case "alpha-patch":
			return `${parts.major}.${parts.minor}.${parts.patch + 1}-alpha.1`;
		case "alpha-minor":
			return `${parts.major}.${parts.minor + 1}.0-alpha.1`;
		case "alpha-major":
			return `${parts.major + 1}.0.0-alpha.1`;
		case "beta-patch":
			return `${parts.major}.${parts.minor}.${parts.patch + 1}-beta.1`;
		case "beta-minor":
			return `${parts.major}.${parts.minor + 1}.0-beta.1`;
		case "beta-major":
			return `${parts.major + 1}.0.0-beta.1`;
		case "rc-patch":
			return `${parts.major}.${parts.minor}.${parts.patch + 1}-rc.1`;
		case "rc-minor":
			return `${parts.major}.${parts.minor + 1}.0-rc.1`;
		case "rc-major":
			return `${parts.major + 1}.0.0-rc.1`;
		case "patch-prerelease":
			return `${parts.major}.${parts.minor}.${parts.patch + 1}-${type}.1`;
		case "release":
			return baseVersion;
		default:
			throw new Error(`Unknown bump type: ${bumpType}`);
	}
}

// Show menu for prerelease selection
async function selectPrereleaseType(baseVersion: string): Promise<string> {
	const choice = await select({
		message: "Select prerelease type:",
		options: [
			{
				value: "alpha",
				label: `alpha (${baseVersion}-alpha.1)`,
			},
			{
				value: "beta",
				label: `beta (${baseVersion}-beta.1)`,
			},
			{
				value: "rc",
				label: `rc (${baseVersion}-rc.1)`,
			},
			{
				value: "manual",
				label: "Manual version",
			},
			{
				value: "back",
				label: "back",
			},
		],
	});

	if (isCancel(choice)) {
		console.log("Released cancelled");
		process.exit(0);
	}

	if (choice === "back") {
		return selectBumpType(baseVersion);
	}

	if (choice === "manual") {
		return await selectManualVersion();
	}

	// Now ask for the version bump type (patch, minor, major)
	return selectPrereleaseBumpType(baseVersion, choice);
}

// Show menu for prerelease version bump type
async function selectPrereleaseBumpType(
	currentVersion: string,
	prereleaseType: string,
): Promise<string> {
	const parts = parseVersion(currentVersion);

	const patchVersion = `${parts.major}.${parts.minor}.${parts.patch + 1}`;
	const minorVersion = `${parts.major}.${parts.minor + 1}.0`;
	const majorVersion = `${parts.major + 1}.0.0`;

	const choice = await select({
		message: "Select version bump type for prerelease:",
		options: [
			{
				value: `${prereleaseType}-patch`,
				label: `Patch (${patchVersion}-${prereleaseType}.1)`,
			},
			{
				value: `${prereleaseType}-minor`,
				label: `Minor (${minorVersion}-${prereleaseType}.1)`,
			},
			{
				value: `${prereleaseType}-major`,
				label: `Major (${majorVersion}-${prereleaseType}.1)`,
			},
			{
				value: "back",
				label: "back",
			},
		],
	});

	if (isCancel(choice)) {
		console.log("Released cancelled");
		process.exit(0);
	}

	if (choice === "back") {
		return selectPrereleaseType(currentVersion);
	}

	return choice;
}

// Show menu for version selection
async function selectBumpType(currentVersion: string): Promise<string> {
	// In non-interactive mode, select the first option
	if (!process.stdin.isTTY) {
		if (isPrerelease(currentVersion)) {
			const type = getPrereleaseType(currentVersion);
			return type === "rc" ? "release" : "next-prerelease";
		} else {
			return "patch";
		}
	}

	if (isPrerelease(currentVersion)) {
		const type = getPrereleaseType(currentVersion);
		const number = getPrereleaseNumber(currentVersion);
		const baseVersion = currentVersion.replace(/-.*$/, "");
		const nextLevel = getNextPrereleaseLevel(type);

		const nextPreVersion = `${baseVersion}-${type}.${number + 1}`;

		const options: Array<{ value: string; label: string }> = [
			{
				value: "increment-prerelease",
				label: `${nextPreVersion} (increment)`,
			},
		];

		if (type === "rc") {
			options.push({
				value: "release",
				label: `${baseVersion} (release)`,
			});
			options.push({
				value: "more",
				label: "more...",
			});
		} else {
			const nextLevelVersion = `${baseVersion}-${nextLevel}.1`;
			options.push({
				value: "next-prerelease",
				label: `${nextLevelVersion} (next level)`,
			});
			options.push({
				value: "release",
				label: `${baseVersion} (release)`,
			});
			options.push({
				value: "more",
				label: "more...",
			});
		}

		const choice = await select({
			message: "Select version bump type:",
			options,
		});

		if (isCancel(choice)) {
			console.log("Released cancelled");
			process.exit(0);
		}

		if (choice === "more") {
			return selectAdvancedMenu(currentVersion);
		}

		return choice;
	} else {
		const patch = parseVersion(currentVersion).patch;
		const nextPatch = `${currentVersion.slice(0, currentVersion.lastIndexOf("."))}.${patch + 1}`;

		const choice = await select({
			message: "Select version bump type:",
			options: [
				{
					value: "patch",
					label: `Patch (${currentVersion} → ${nextPatch})`,
				},
				{
					value: "minor",
					label: "Minor",
				},
				{
					value: "major",
					label: "Major",
				},
				{
					value: "prerelease",
					label: "Prerelease",
				},
				{
					value: "manual",
					label: "Manual version",
				},
			],
		});

		if (isCancel(choice)) {
			console.log("Released cancelled");
			process.exit(0);
		}

		if (choice === "prerelease") {
			return selectPrereleaseType(currentVersion);
		}

		if (choice === "manual") {
			return await selectManualVersion();
		}

		return choice;
	}
}

// Show advanced menu
async function selectAdvancedMenu(currentVersion: string): Promise<string> {
	const type = getPrereleaseType(currentVersion);
	const baseVersion = currentVersion.replace(/-.*$/, "");
	const parts = parseVersion(currentVersion);
	const nextPatch = `${parts.major}.${parts.minor}.${parts.patch + 1}`;
	const patchVersion = `${nextPatch}-${type}.1`;

	const options: Array<{ value: string; label: string }> = [
		{
			value: "patch-prerelease",
			label: `${patchVersion} (patch bump)`,
		},
	];

	if (type === "alpha") {
		options.push({
			value: "alpha-to-rc",
			label: `${baseVersion}-rc.1 (to RC)`,
		});
	}

	options.push({
		value: "back",
		label: "back",
	});

	const choice = await select({
		message: "Advanced Options:",
		options,
	});

	if (isCancel(choice)) {
		console.log("Released cancelled");
		process.exit(0);
	}

	if (choice === "back") {
		return selectBumpType(currentVersion);
	}

	return choice;
}

// Main function
async function main() {
	const program = new Command();

	program
		.name("release")
		.description("Release script for ha-ws-js-sugar")
		.option("--dry-run", "Run without making changes")
		.option("--tag", "Create and push git tag")
		.parse();

	const options = program.opts();
	const dryRun = options.dryRun === true;

	console.log(
		dryRun ? "\n=== Release Script (DRY RUN) ===" : "\n=== Release Script ===",
	);
	console.log();

	// Step 1: Check git status
	let hasUncommittedChanges = false;
	if (!dryRun) {
		try {
			execSync("git diff-index --quiet HEAD --", { stdio: "pipe" });
			console.log("✓ Working directory is clean");
		} catch {
			hasUncommittedChanges = true;
			console.warn("⚠ Working directory has uncommitted changes");

			// Ask user if they want to commit changes together
			const { confirm } = await import("@clack/prompts");
			const shouldCommit = await confirm({
				message:
					"Do you want to commit all changes together with the version bump?",
				active: "Yes",
				inactive: "No",
			});

			if (isCancel(shouldCommit)) {
				console.log("Released cancelled");
				process.exit(0);
			}

			if (!shouldCommit) {
				console.error(
					"✗ Cannot proceed with uncommitted changes. Please commit them first.",
				);
				process.exit(1);
			}

			console.log("✓ All changes will be committed together");
		}
	}

	// Step 2: Get current version
	const currentVersion = getCurrentVersion();
	console.log(`✓ Current version: ${currentVersion}`);
	console.log();

	// Step 3: Select bump type
	const bumpType = await selectBumpType(currentVersion);
	console.log();

	// Step 4: Calculate new version
	// If bumpType looks like a version (contains dots), use it directly
	const newVersion =
		bumpType.includes(".") && /^\d+\.\d+\.\d+/.test(bumpType)
			? bumpType
			: createVersion(currentVersion, bumpType);
	console.log(`New version: ${currentVersion} → ${newVersion}`);
	console.log();

	// Step 5: Update version in package.json
	console.log("→ Updating version in package.json...");
	if (!dryRun) {
		execSync(
			`pnpm version ${newVersion} --no-commit-hooks --no-git-tag-version`,
		);
	}
	console.log(`✓ Version updated to ${newVersion}`);

	// Step 6: Commit
	console.log("→ Committing changes...");
	if (!dryRun) {
		// If there are uncommitted changes, add all files; otherwise just add version files
		if (hasUncommittedChanges) {
			execSync("git add .", { stdio: "pipe" });
			execSync(`git commit -m "Release version ${newVersion}"`, {
				stdio: "pipe",
			});
		} else {
			execSync("git add package.json pnpm-lock.yaml", { stdio: "pipe" });
			execSync(`git commit -m "Release version ${newVersion}"`, {
				stdio: "pipe",
			});
		}
	}
	console.log("✓ Changes committed");

	// Step 7: Create tag (if --tag flag is set)
	if (options.tag) {
		console.log("→ Creating git tag...");
		if (!dryRun) {
			execSync(`git tag v${newVersion}`, { stdio: "pipe" });
		}
		console.log(`✓ Tag v${newVersion} created`);

		// Step 8: Push changes and tag
		console.log("→ Pushing changes to remote...");
		if (!dryRun) {
			execSync("git push origin main", { stdio: "pipe" });
			execSync(`git push origin v${newVersion}`, { stdio: "pipe" });
		}
		console.log("✓ Changes and tag pushed");
	} else {
		console.log("→ Pushing changes to remote...");
		if (!dryRun) {
			execSync("git push origin main", { stdio: "pipe" });
		}
		console.log("✓ Changes pushed");
		console.warn(
			"⚠ Git tag not created (use --tag flag to create and push it)",
		);
	}

	// Step 9: Summary
	const prereleaseType = getPrereleaseType(newVersion);

	if (prereleaseType !== "stable") {
		console.log(`\nℹ This is a ${prereleaseType} release`);
	}

	// Final summary
	console.log();
	console.log(dryRun ? "=== Dry Run Complete ===" : "=== Release Complete ===");
	console.log(`Version: ${newVersion}`);
	if (options.tag) {
		console.log(`Tag: v${newVersion}`);
	}

	if (prereleaseType !== "stable") {
		console.log(`Type: Prerelease (${prereleaseType})`);
	} else {
		console.log("Type: Stable");
	}
	console.log();
}

main().catch(console.error);
