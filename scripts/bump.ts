#!/usr/bin/env tsx

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCancel, select } from '@clack/prompts';
import { Command } from 'commander';

interface VersionParts {
	major: number;
	minor: number;
	patch: number;
}

const PRERELEASE_LEVELS = ['alpha', 'beta', 'rc'] as const;
type PrereleaseLevel = typeof PRERELEASE_LEVELS[number];

interface PrereleaseInfo {
	type: PrereleaseLevel | 'stable';
	number: number;
}

// Parse version from package.json
function getCurrentVersion(): string {
	const packagePath = path.join(process.cwd(), 'package.json');
	const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
	return packageJson.version;
}

// Parse version into components
function parseVersion(version: string): VersionParts {
	const baseVersion = version.replace(/-.*$/, '');
	const [major, minor, patch] = baseVersion.split('.').map(Number);
	return { major, minor, patch };
}

// Check if version is a prerelease
function isPrerelease(version: string): boolean {
	return /-/.test(version);
}

// Extract prerelease type
function getPrereleaseType(version: string): PrereleaseLevel | 'stable' {
	const match = version.match(/-([a-z]+)/);
	return (match?.[1] as PrereleaseLevel) || 'stable';
}

// Extract prerelease number
function getPrereleaseNumber(version: string): number {
	const match = version.match(/-([a-z]+)\.(\d+)/);
	return match ? Number(match[2]) : 0;
}

// Check if newVer is strictly greater than currentVer
function isVersionGreater(newVer: string, currentVer: string): boolean {
	const np = parseVersion(newVer);
	const cp = parseVersion(currentVer);
	if (np.major !== cp.major) return np.major > cp.major;
	if (np.minor !== cp.minor) return np.minor > cp.minor;
	if (np.patch !== cp.patch) return np.patch > cp.patch;
	// Same base version: stable > any prerelease
	const nt = getPrereleaseType(newVer);
	const ct = getPrereleaseType(currentVer);
	if (nt === 'stable' && ct !== 'stable') return true;
	if (nt !== 'stable' && ct === 'stable') return false;
	if (nt === 'stable' && ct === 'stable') return false;
	// Both prerelease: compare levels then numbers
	const ni = PRERELEASE_LEVELS.indexOf(nt as PrereleaseLevel);
	const ci = PRERELEASE_LEVELS.indexOf(ct as PrereleaseLevel);
	if (ni !== ci) return ni > ci;
	return getPrereleaseNumber(newVer) > getPrereleaseNumber(currentVer);
}

// Get next prerelease level (null if already at the last level)
function getNextPrereleaseLevel(current: PrereleaseLevel): PrereleaseLevel | null {
	const idx = PRERELEASE_LEVELS.indexOf(current);
	return idx < PRERELEASE_LEVELS.length - 1 ? PRERELEASE_LEVELS[idx + 1] : null;
}

// Detect the package manager name and version from the running process
function detectPackageManager(): string {
	const userAgent = process.env.npm_config_user_agent;
	if (userAgent) {
		// Format: "pnpm/9.1.0 npm/? node/v20.0.0 ..."
		const match = userAgent.match(/^([\w-]+)\/([^\s]+)/);
		if (match) {
			return `${match[1]}@${match[2]}`;
		}
	}
	// Fallback: detect via lock files
	const cwd = process.cwd();
	if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {
		const version = execSync('pnpm --version', { encoding: 'utf-8' }).trim();
		return `pnpm@${version}`;
	}
	if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
		const version = execSync('yarn --version', { encoding: 'utf-8' }).trim();
		return `yarn@${version}`;
	}
	if (fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock'))) {
		const version = execSync('bun --version', { encoding: 'utf-8' }).trim();
		return `bun@${version}`;
	}
	const version = execSync('npm --version', { encoding: 'utf-8' }).trim();
	return `npm@${version}`;
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
	const { text } = await import('@clack/prompts');

	let version = '';
	let isValid = false;

	while (!isValid) {
		const input = await text({
			message: 'Enter version (e.g., 1.0.0 or 1.0.0-alpha.1):',
			validate: (value) => {
				const validation = validateVersion(value ?? '');
				if (!validation.valid) {
					return validation.error;
				}
				return undefined;
			},
		});

		if (isCancel(input)) {
			console.log('Released cancelled');
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

// Resolve new version from CLI --bump flag
function resolveVersionFromCLIBump(current: string, bump: string): string {
	const [base, preid] = bump.split('+');
	const parts = parseVersion(current);
	const currentType = getPrereleaseType(current);
	const currentNumber = getPrereleaseNumber(current);
	const baseVersion = current.replace(/-.*$/, '');
	const firstLevel = PRERELEASE_LEVELS[0];

	if (isPrerelease(current)) {
		switch (base) {
			case 'patch':
				return `${parts.major}.${parts.minor}.${parts.patch + 1}-${firstLevel}.1`;
			case 'minor':
				return `${parts.major}.${parts.minor + 1}.0-${firstLevel}.1`;
			case 'major':
				return `${parts.major + 1}.0.0-${firstLevel}.1`;
			case 'release':
				return baseVersion;
			case 'prerelease': {
				if (!preid) {
					return `${baseVersion}-${currentType}.${currentNumber + 1}`;
				}
				if (preid === 'next') {
					const currentIdx = PRERELEASE_LEVELS.indexOf(currentType as PrereleaseLevel);
					if (currentIdx === PRERELEASE_LEVELS.length - 1) {
						throw new Error(
							`Cannot bump to next prerelease level: "${currentType}" is already the last level (${PRERELEASE_LEVELS.join(' → ')})`,
						);
					}
					return `${baseVersion}-${PRERELEASE_LEVELS[currentIdx + 1]}.1`;
				}
				if (!PRERELEASE_LEVELS.includes(preid as PrereleaseLevel)) {
					throw new Error(
						`Unknown prerelease type: "${preid}". Valid types: ${PRERELEASE_LEVELS.join(', ')}`,
					);
				}
				const targetIdx = PRERELEASE_LEVELS.indexOf(preid as PrereleaseLevel);
				const currentIdx = PRERELEASE_LEVELS.indexOf(currentType as PrereleaseLevel);
				if (targetIdx < currentIdx) {
					throw new Error(
						`Cannot regress prerelease type from "${currentType}" to "${preid}"`,
					);
				}
				if (targetIdx === currentIdx) {
					return `${baseVersion}-${currentType}.${currentNumber + 1}`;
				}
				return `${baseVersion}-${preid}.1`;
			}
			default:
				throw new Error(`Unknown bump type: "${bump}"`);
		}
	} else {
		switch (base) {
			case 'patch':
				return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
			case 'minor':
				return `${parts.major}.${parts.minor + 1}.0`;
			case 'major':
				return `${parts.major + 1}.0.0`;
			case 'release':
				throw new Error(`Cannot use --bump release on a stable version "${current}"`);
			case 'prerelease': {
				if (preid === 'next') {
					throw new Error('Cannot use --bump prerelease+next on a stable version');
				}
				if (preid && !PRERELEASE_LEVELS.includes(preid as PrereleaseLevel)) {
					throw new Error(
						`Unknown prerelease type: "${preid}". Valid types: ${PRERELEASE_LEVELS.join(', ')}`,
					);
				}
				const tag = preid ?? firstLevel;
				return `${parts.major}.${parts.minor}.${parts.patch + 1}-${tag}.1`;
			}
			default:
				throw new Error(`Unknown bump type: "${bump}"`);
		}
	}
}

// Show bump type menu for stable versions
async function selectBumpTypeStable(currentVersion: string): Promise<string> {
	const parts = parseVersion(currentVersion);
	const firstLevel = PRERELEASE_LEVELS[0];
	const patchVer = `${parts.major}.${parts.minor}.${parts.patch + 1}`;
	const minorVer = `${parts.major}.${parts.minor + 1}.0`;
	const majorVer = `${parts.major + 1}.0.0`;
	const preVer = `${patchVer}-${firstLevel}.1`;

	const choice = await select({
		message: 'Select version bump type:',
		options: [
			{ value: 'patch', label: `Patch     (${currentVersion} → ${patchVer})` },
			{ value: 'minor', label: `Minor     (${currentVersion} → ${minorVer})` },
			{ value: 'major', label: `Major     (${currentVersion} → ${majorVer})` },
			{ value: 'prerelease', label: `Prerelease (${currentVersion} → ${preVer})` },
			{ value: 'advanced', label: 'Advanced...' },
		],
	});

	if (isCancel(choice)) {
		console.log('Release cancelled');
		process.exit(0);
	}

	if (choice === 'advanced') return selectAdvancedMenuStable(currentVersion);
	return choice;
}

// Show advanced options for stable versions
async function selectAdvancedMenuStable(currentVersion: string): Promise<string> {
	const parts = parseVersion(currentVersion);
	const patchVer = `${parts.major}.${parts.minor}.${parts.patch + 1}`;

	const options: Array<{ value: string; label: string }> = PRERELEASE_LEVELS.map((level) => ({
		value: `prerelease+${level}`,
		label: `Prerelease ${level.padEnd(5)} (${currentVersion} → ${patchVer}-${level}.1)`,
	}));
	options.push({ value: 'manual', label: 'Manual version' });
	options.push({ value: 'back', label: 'Back' });

	const choice = await select({ message: 'Advanced options:', options });

	if (isCancel(choice)) {
		console.log('Release cancelled');
		process.exit(0);
	}

	if (choice === 'back') return selectBumpTypeStable(currentVersion);
	if (choice === 'manual') return selectManualVersion();
	return choice;
}

// Show bump type menu for prerelease versions
async function selectBumpTypePrerelease(currentVersion: string): Promise<string> {
	const type = getPrereleaseType(currentVersion) as PrereleaseLevel;
	const number = getPrereleaseNumber(currentVersion);
	const baseVersion = currentVersion.replace(/-.*$/, '');
	const nextLevel = getNextPrereleaseLevel(type);

	const incrVer = `${baseVersion}-${type}.${number + 1}`;

	const options: Array<{ value: string; label: string }> = [
		{ value: 'prerelease', label: `Increment  (${currentVersion} → ${incrVer})` },
	];

	if (nextLevel !== null) {
		const nextVer = `${baseVersion}-${nextLevel}.1`;
		options.push({ value: 'prerelease+next', label: `Next level (${currentVersion} → ${nextVer})` });
	}

	options.push({ value: 'release', label: `Release    (${currentVersion} → ${baseVersion})` });
	options.push({ value: 'advanced', label: 'Advanced...' });

	const choice = await select({ message: 'Select version bump type:', options });

	if (isCancel(choice)) {
		console.log('Release cancelled');
		process.exit(0);
	}

	if (choice === 'advanced') return selectAdvancedMenuPrerelease(currentVersion);
	return choice;
}

// Show advanced options for prerelease versions
async function selectAdvancedMenuPrerelease(currentVersion: string): Promise<string> {
	const type = getPrereleaseType(currentVersion) as PrereleaseLevel;
	const currentIdx = PRERELEASE_LEVELS.indexOf(type);
	const baseVersion = currentVersion.replace(/-.*$/, '');
	const parts = parseVersion(currentVersion);
	const firstLevel = PRERELEASE_LEVELS[0];

	const options: Array<{ value: string; label: string }> = [];

	// Only levels strictly above current (no regression)
	for (const level of PRERELEASE_LEVELS) {
		if (PRERELEASE_LEVELS.indexOf(level) > currentIdx) {
			options.push({
				value: `prerelease+${level}`,
				label: `Jump to ${level.padEnd(5)} (${currentVersion} → ${baseVersion}-${level}.1)`,
			});
		}
	}

	const patchVer = `${parts.major}.${parts.minor}.${parts.patch + 1}-${firstLevel}.1`;
	const minorVer = `${parts.major}.${parts.minor + 1}.0-${firstLevel}.1`;
	const majorVer = `${parts.major + 1}.0.0-${firstLevel}.1`;

	options.push({ value: 'patch', label: `Patch bump (${currentVersion} → ${patchVer})` });
	options.push({ value: 'minor', label: `Minor bump (${currentVersion} → ${minorVer})` });
	options.push({ value: 'major', label: `Major bump (${currentVersion} → ${majorVer})` });
	options.push({ value: 'manual', label: 'Manual version' });
	options.push({ value: 'back', label: 'Back' });

	const choice = await select({ message: 'Advanced options:', options });

	if (isCancel(choice)) {
		console.log('Release cancelled');
		process.exit(0);
	}

	if (choice === 'back') return selectBumpTypePrerelease(currentVersion);
	if (choice === 'manual') return selectManualVersion();
	return choice;
}

// Show version bump menu — entry point (dispatches to stable or prerelease variant)
async function selectBumpType(currentVersion: string): Promise<string> {
	// In non-interactive mode, auto-select a sensible default
	if (!process.stdin.isTTY) {
		if (isPrerelease(currentVersion)) {
			const type = getPrereleaseType(currentVersion);
			const isLastLevel = PRERELEASE_LEVELS.indexOf(type as PrereleaseLevel) === PRERELEASE_LEVELS.length - 1;
			return isLastLevel ? 'release' : 'prerelease+next';
		}
		return 'patch';
	}

	if (isPrerelease(currentVersion)) {
		return selectBumpTypePrerelease(currentVersion);
	}
	return selectBumpTypeStable(currentVersion);
}

// Main function
async function main() {
	const program = new Command();

	program
		.name('release')
		.description('Release script for ha-ws-js-sugar')
		.option('--dry-run', 'Run without making changes (implies --verbose)')
		.option('--verbose', 'Show detailed step-by-step output')
		.option('--tag', 'Create and push git tag')
		.option(
			'--bump <type>',
			'Bump type: patch, minor, major, prerelease[+alpha|beta|rc|next], release',
		)
		.option('--version <version>', 'Set version explicitly (e.g. 1.2.3 or 1.2.3-alpha.1)')
		.option('--commit', 'Auto-confirm uncommitted changes prompt')
		.option('--ignore-pm', 'Skip updating the packageManager field')
		.option('--no-pm', 'Remove the packageManager field')
		.parse();

	const options = program.opts();
	const dryRun = options.dryRun === true;
	const verbose = dryRun || options.verbose === true;
	const log = (...args: unknown[]) => { if (verbose) console.log(...args); };

	console.log(dryRun ? '\n=== Release Script (DRY RUN) ===' : '\n=== Release Script ===');
	log();

	// Step 1: Check git status
	let hasUncommittedChanges = false;
	try {
		execSync('git diff-index --quiet HEAD --', { stdio: 'pipe' });
		log('✓ Working directory is clean');
	} catch {
		hasUncommittedChanges = true;
		console.warn('⚠ Working directory has uncommitted changes');

		// Ask user if they want to commit changes together
		let shouldCommit: boolean;
		if (options.commit) {
			shouldCommit = true;
		} else {
			const { confirm } = await import('@clack/prompts');
			const result = await confirm({
				message:
					'Do you want to commit all changes together with the version bump?',
				active: 'Yes',
				inactive: 'No',
			});
			if (isCancel(result)) {
				console.log('Release cancelled');
				process.exit(0);
			}
			shouldCommit = result;
		}
		if (!shouldCommit) {
			console.error(
				'✗ Cannot proceed with uncommitted changes. Please commit them first.',
			);
			process.exit(1);
		}
		log('✓ All changes will be committed together');
	}

	// Step 2: Get current version
	const currentVersion = getCurrentVersion();
	log(`✓ Current version: ${currentVersion}`);
	log();

	// Step 3 & 4: Determine new version
	let newVersion: string;

	if (options.version) {
		const validation = validateVersion(options.version);
		if (!validation.valid) {
			console.error(`✗ ${validation.error}`);
			process.exit(1);
		}
		newVersion = options.version;
		log(`✓ New version: ${currentVersion} → ${newVersion}`);
	} else if (options.bump) {
		try {
			newVersion = resolveVersionFromCLIBump(currentVersion, options.bump);
			log(`✓ New version: ${currentVersion} → ${newVersion}`);
		} catch (e) {
			console.error(`✗ ${(e as Error).message}`);
			process.exit(1);
		}
	} else {
		// Step 3: Select bump type (interactive)
		const bumpOrVersion = await selectBumpType(currentVersion);
		log();
		// Step 4: Calculate new version
		if (/^\d+\.\d+\.\d+/.test(bumpOrVersion)) {
			newVersion = bumpOrVersion;
		} else {
			newVersion = resolveVersionFromCLIBump(currentVersion, bumpOrVersion);
		}
		log(`✓ New version: ${currentVersion} → ${newVersion}`);
	}

	// Global regression check
	if (!isVersionGreater(newVersion, currentVersion)) {
		console.error(`✗ Version "${newVersion}" must be strictly greater than "${currentVersion}"`);
		process.exit(1);
	}

	log();

	// Step 5: Update version in package.json
	log('→ Updating version in package.json...');
	if (!dryRun) {
		execSync(
			`npm version ${newVersion} --no-commit-hooks --no-git-tag-version`,
		);

		const packagePath = path.join(process.cwd(), 'package.json');
		const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
		if (options.pm === false) {
			delete packageJson.packageManager;
		} else if (!options.ignorePm) {
			packageJson.packageManager = detectPackageManager();
		}
		fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, '\t')}\n`);
	}
	if (options.pm === false) {
		log('✓ packageManager field removed');
	} else if (options.ignorePm) {
		log('✓ packageManager field unchanged');
	} else {
		log(`✓ packageManager set to ${detectPackageManager()}`);
	}

	// Step 6: Commit
	log('→ Committing changes...');
	if (!dryRun) {
		if (hasUncommittedChanges) {
			execSync('git add .', { stdio: 'pipe' });
		} else {
			execSync('git add package.json pnpm-lock.yaml', { stdio: 'pipe' });
		}
		execSync(`git commit -m "Release version ${newVersion}"`, { stdio: 'pipe' });
	}
	log('✓ Changes committed');

	// Step 7: Push + optional tag
	if (options.tag) {
		log('→ Creating git tag...');
		if (!dryRun) {
			execSync(`git tag v${newVersion}`, { stdio: 'pipe' });
		}
		log(`✓ Tag v${newVersion} created`);

		log('→ Pushing changes to remote...');
		if (!dryRun) {
			execSync('git push origin main', { stdio: 'pipe' });
			execSync(`git push origin v${newVersion}`, { stdio: 'pipe' });
		}
		log('✓ Changes and tag pushed');
	} else {
		log('→ Pushing changes to remote...');
		if (!dryRun) {
			execSync('git push origin main', { stdio: 'pipe' });
		}
		log('✓ Changes pushed');
		log('⚠ Git tag not created (use --tag flag to create and push it)');
	}

	// Final summary
	const prereleaseType = getPrereleaseType(newVersion);

	console.log();
	console.log(dryRun ? '=== Dry Run Complete ===' : '=== Release Complete ===');
	console.log(`Version: ${currentVersion} → ${newVersion}`);
	if (options.tag) {
		console.log(`Tag:     v${newVersion}`);
	}
	if (prereleaseType !== 'stable') {
		console.log(`Type:    Prerelease (${prereleaseType})`);
	} else {
		console.log('Type:    Stable');
	}
	console.log();
}

main().catch(console.error);
