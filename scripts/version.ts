#!/usr/bin/env tsx

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCancel, select } from '@clack/prompts';
import { Command, InvalidArgumentError } from 'commander';

interface VersionParts {
	major: number;
	minor: number;
	patch: number;
}

const PRERELEASE_LEVELS = ['alpha', 'beta', 'rc'] as const;
type PrereleaseLevel = (typeof PRERELEASE_LEVELS)[number];

interface CLIOptions {
	dryRun: boolean;
	verbose: boolean;
	nonInteractive: boolean;
	tag: boolean;
	push: boolean;
	bump: string | undefined;
	version: string | undefined;
	commit: boolean;
	ignorePm: boolean;
	pm: boolean;
}

const program = new Command();
program
	.name('release')
	.description('Version bump utility')
	.option('--dry-run', 'Run without making changes (implies --verbose)', false)
	.option('--verbose', 'Show detailed step-by-step output', false)
	.option('--non-interactive', 'Disable all prompts, use defaults or flags', false)
	.option('--tag', 'Create a git tag', false)
	.option('--push', 'Push commit and tag to remote', false)
	.option(
		'--bump <type>',
		'Bump type: patch, minor, major, prerelease[+alpha|beta|rc|next], release',
	)
	.option(
		'--version <version>',
		'Set version explicitly (e.g. 1.2.3 or 1.2.3-alpha.1)',
		(value: string) => {
			const validation = validateVersion(value);
			if (!validation.valid) throw new InvalidArgumentError(validation.error ?? 'Invalid version');
			return value;
		},
	)
	.option('--commit', 'Auto-confirm uncommitted changes prompt', false)
	.option('--ignore-pm', 'Skip updating the packageManager field', false)
	.option('--no-pm', 'Remove the packageManager field')
	.parse();

function parseCLIOptions(): CLIOptions {
	return program.opts<CLIOptions>();
}

const options = parseCLIOptions();
const isNonInteractive = options.nonInteractive;

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
function getNextPrereleaseLevel(
	current: PrereleaseLevel,
): PrereleaseLevel | null {
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
	if (
		fs.existsSync(path.join(cwd, 'bun.lockb')) ||
		fs.existsSync(path.join(cwd, 'bun.lock'))
	) {
		const version = execSync('bun --version', { encoding: 'utf-8' }).trim();
		return `bun@${version}`;
	}
	const version = execSync('npm --version', { encoding: 'utf-8' }).trim();
	return `npm@${version}`;
}

// Validate semantic version format
function validateVersion(version: string): { valid: boolean; error?: string } {
	// Format: x.y.z or x.y.z-<level>.<n>
	const levels = PRERELEASE_LEVELS.join('|');
	const versionRegex = new RegExp(`^[0-9]+\\.[0-9]+\\.[0-9]+(-(${levels})\\.([0-9]+))?$`);
	const match = versionRegex.exec(version);

	if (!match) {
		return {
			valid: false,
			error: `Invalid version format: "${version}". Expected format: x.y.z or x.y.z-<level>.<n> (e.g. 1.2.3-alpha.1). Valid prerelease levels: ${PRERELEASE_LEVELS.join(', ')}`,
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
					const currentIdx = PRERELEASE_LEVELS.indexOf(
						currentType as PrereleaseLevel,
					);
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
				const currentIdx = PRERELEASE_LEVELS.indexOf(
					currentType as PrereleaseLevel,
				);
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
				throw new Error(
					`Cannot use --bump release on a stable version "${current}"`,
				);
			case 'prerelease': {
				if (preid === 'next') {
					throw new Error(
						'Cannot use --bump prerelease+next on a stable version',
					);
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
			{
				value: 'prerelease',
				label: `Prerelease (${currentVersion} → ${preVer})`,
			},
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
async function selectAdvancedMenuStable(
	currentVersion: string,
): Promise<string> {
	const parts = parseVersion(currentVersion);
	const patchVer = `${parts.major}.${parts.minor}.${parts.patch + 1}`;

	const options: Array<{ value: string; label: string }> =
		PRERELEASE_LEVELS.map((level) => ({
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
async function selectBumpTypePrerelease(
	currentVersion: string,
): Promise<string> {
	const type = getPrereleaseType(currentVersion) as PrereleaseLevel;
	const number = getPrereleaseNumber(currentVersion);
	const baseVersion = currentVersion.replace(/-.*$/, '');
	const nextLevel = getNextPrereleaseLevel(type);

	const incrVer = `${baseVersion}-${type}.${number + 1}`;

	const options: Array<{ value: string; label: string }> = [
		{
			value: 'prerelease',
			label: `Increment  (${currentVersion} → ${incrVer})`,
		},
	];

	if (nextLevel !== null) {
		const nextVer = `${baseVersion}-${nextLevel}.1`;
		options.push({
			value: 'prerelease+next',
			label: `Next level (${currentVersion} → ${nextVer})`,
		});
	}

	options.push({
		value: 'release',
		label: `Release    (${currentVersion} → ${baseVersion})`,
	});
	options.push({ value: 'advanced', label: 'Advanced...' });

	const choice = await select({
		message: 'Select version bump type:',
		options,
	});

	if (isCancel(choice)) {
		console.log('Release cancelled');
		process.exit(0);
	}

	if (choice === 'advanced')
		return selectAdvancedMenuPrerelease(currentVersion);
	return choice;
}

// Show advanced options for prerelease versions
async function selectAdvancedMenuPrerelease(
	currentVersion: string,
): Promise<string> {
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

	options.push({
		value: 'patch',
		label: `Patch bump (${currentVersion} → ${patchVer})`,
	});
	options.push({
		value: 'minor',
		label: `Minor bump (${currentVersion} → ${minorVer})`,
	});
	options.push({
		value: 'major',
		label: `Major bump (${currentVersion} → ${majorVer})`,
	});
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
	if (isNonInteractive) {
		if (isPrerelease(currentVersion)) {
			return 'prerelease';
		}
		return 'patch';
	}

	if (isPrerelease(currentVersion)) {
		return selectBumpTypePrerelease(currentVersion);
	}
	return selectBumpTypeStable(currentVersion);
}

// ─── Logger / template system ─────────────────────────────────────────────────
type MessageKey =
	| 'workingDirClean'
	| 'newVersion'
	| 'updatingPackageJson'
	| 'packageManagerSet'
	| 'packageManagerRemoved'
	| 'packageManagerUnchanged'
	| 'committing'
	| 'committed'
	| 'creatingTag'
	| 'tagCreated'
	| 'pushing'
	| 'pushed'
	| 'summary';

type TemplateVars = Record<string, string>;
type TemplateFn = (vars: TemplateVars) => string;
type TemplateMap = Partial<Record<MessageKey, string | TemplateFn>>;

interface ModeConfig {
	log: TemplateMap;
	warn: TemplateMap;
	dryRunPrefix: string;
	showBlanks: boolean;
	dryRunOmit?: MessageKey[];
}

function resolveTemplate(tpl: string | TemplateFn, vars: TemplateVars): string {
	return typeof tpl === 'function' ? tpl(vars) : tpl;
}

function createLogger(config: ModeConfig, dryRun: boolean, active: boolean) {
	const prefix = dryRun ? config.dryRunPrefix : '';
	const fmt = (msg: string) => `${prefix}${msg}`;

	const warn = (key: MessageKey, vars: TemplateVars = {}): void => {
		const tpl = config.warn[key];
		if (tpl !== undefined) console.warn(resolveTemplate(tpl, vars));
	};

	const log = (key?: MessageKey, vars: TemplateVars = {}): void => {
		if (!active) return;
		if (!key) {
			if (config.showBlanks && !dryRun) console.log();
			return;
		}
		if (dryRun && config.dryRunOmit?.includes(key)) return;
		const tpl = config.log[key];
		if (tpl !== undefined) console.log(fmt(resolveTemplate(tpl, vars)));
	};

	return { log, warn };
}

const interactiveConfig: ModeConfig = {
	dryRunPrefix: '\x1b[2;33m◆ dry-run\x1b[0m  ',
	showBlanks: true,
	dryRunOmit: ['updatingPackageJson', 'committing', 'creatingTag', 'pushing'],
	log: {
		workingDirClean: '✓ Working directory is clean',

		updatingPackageJson: '→ Updating version in package.json...',
		packageManagerSet: ({ pm }) => `✓ packageManager set to ${pm}`,
		packageManagerRemoved: '✓ packageManager field removed',
		packageManagerUnchanged: '✓ packageManager field unchanged',
		committing: '→ Committing changes...',
		committed: '✓ Changes committed',
		creatingTag: '→ Creating git tag...',
		tagCreated: ({ version }) => `✓ Tag #v${version} created`,
		pushing: '→ Pushing to remote...',
		pushed: ({ withTag, version }) => withTag === 'true' ? `✓ Commit and tag #v${version} pushed` : '✓ Commit pushed',
	},
	warn: {},
};

const nonInteractiveConfig: ModeConfig = {
	dryRunPrefix: '\x1b[33m[dry-run]\x1b[0m ',
	showBlanks: false,
	log: {
		summary: ({ from, to, extras }) =>
			extras ? `${from} => ${to} (${extras})` : `${from} => ${to}`,
	},
	warn: {},
};

const nonInteractiveVerboseConfig: ModeConfig = {
	...nonInteractiveConfig,
	dryRunOmit: ['updatingPackageJson', 'committing', 'creatingTag', 'pushing'],
	log: {
		workingDirClean: 'working directory is clean',
		newVersion: ({ from, to }) => `version update: ${from} => ${to}`,
		updatingPackageJson: 'updating version in package.json...',
		packageManagerSet: ({ pm }) => `packageManager set to ${pm}`,
		packageManagerRemoved: 'packageManager field removed',
		packageManagerUnchanged: 'packageManager field unchanged',
		committing: 'committing changes...',
		committed: 'changes committed',
		creatingTag: ({ version }) => `creating git tag #v${version}...`,
		tagCreated: ({ version }) => `tag #v${version} created`,
		pushing: 'pushing to remote...',
		pushed: ({ withTag, version }) => withTag === 'true' ? `commit and tag #v${version} pushed` : 'commit pushed',
	},
};

// Main function
async function main() {
	const dryRun = options.dryRun === true;
	const verbose = dryRun || options.verbose === true;
	const modeConfig = isNonInteractive
		? (verbose ? nonInteractiveVerboseConfig : nonInteractiveConfig)
		: interactiveConfig;
	const loggerActive = isNonInteractive || verbose;
	const { log, warn } = createLogger(modeConfig, dryRun, loggerActive);

	if (!isNonInteractive) {
		console.log(
			dryRun ? '\n=== Release Script (DRY RUN) ===' : '\n=== Release Script ===',
		);
	}

	// ── Phase 1: Gather all inputs (silently) ───────────────────────────────
	const currentVersion = getCurrentVersion();

	const abortRegression = (v: string) => {
		if (isNonInteractive) {
			console.error(`version "${v}" must be strictly greater than "${currentVersion}"`);
			process.exit(1);
		}
		console.log(`\x1b[33m◆ Aborted — ${v} is not greater than current version ${currentVersion}.\x1b[0m`);
		process.exit(0);
	};

	// Early regression check when version is known upfront (no prompts needed)
	if (options.version && !isVersionGreater(options.version, currentVersion)) abortRegression(options.version);
	if (options.bump) {
		try {
			const v = resolveVersionFromCLIBump(currentVersion, options.bump);
			if (!isVersionGreater(v, currentVersion)) abortRegression(v);
		} catch (e) {
			console.error(isNonInteractive ? (e as Error).message : `✗ ${(e as Error).message}`);
			process.exit(1);
		}
	}

	let hasUncommittedChanges = false;
	try {
		execSync('git diff-index --quiet HEAD --', { stdio: 'pipe' });
	} catch {
		hasUncommittedChanges = true;

		let shouldCommit: boolean;
		if (options.commit) {
			shouldCommit = true;
		} else if (isNonInteractive) {
			console.error('cannot proceed with uncommitted changes. use --commit to include them.');
			process.exit(1);
		} else {
			const { confirm } = await import('@clack/prompts');
			const result = await confirm({
				message: 'Do you want to commit all changes together with the version bump?',
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
			if (isNonInteractive) {
				console.error('cannot proceed with uncommitted changes. please commit them first.');
				process.exit(1);
			}
			console.log('\x1b[33m◆ Aborted — please commit your changes first.\x1b[0m');
			process.exit(0);
		}
	}

	let newVersion: string;
	if (options.version) {
		newVersion = options.version;
	} else if (options.bump) {
		newVersion = resolveVersionFromCLIBump(currentVersion, options.bump);
	} else {
		const bumpOrVersion = await selectBumpType(currentVersion);
		if (/^\d+\.\d+\.\d+/.test(bumpOrVersion)) {
			newVersion = bumpOrVersion;
		} else {
			newVersion = resolveVersionFromCLIBump(currentVersion, bumpOrVersion);
		}
		if (!isVersionGreater(newVersion, currentVersion)) abortRegression(newVersion);
	}

	const { confirm, log: clackLog } = await import('@clack/prompts');

	// Show resolved version in clack style when flags bypass the menu
	if (!isNonInteractive && (options.version || options.bump)) {
		clackLog.step(`Version update: ${currentVersion} → ${newVersion}`);
	}

	let createTag = options.tag;
	if (!isNonInteractive && !options.tag) {
		const result = await confirm({
			message: `Create git tag #v${newVersion}?`,
			active: 'Yes',
			inactive: 'No',
		});
		if (isCancel(result)) {
			console.log('Release cancelled');
			process.exit(0);
		}
		createTag = result;
	}

	let pushToRemote = options.push;
	if (!isNonInteractive && !options.push) {
		const result = await confirm({
			message: 'Push to remote?',
			active: 'Yes',
			inactive: 'No',
		});
		if (isCancel(result)) {
			console.log('Release cancelled');
			process.exit(0);
		}
		pushToRemote = result;
	}

	// ── Phase 2: Confirmation (interactive, non-dry-run) ────────────────────
	if (!isNonInteractive && !dryRun) {
		const extras: string[] = [];
		if (createTag) extras.push(`tag #v${newVersion}`);
		if (pushToRemote) extras.push('push');
		const suffix = extras.length > 0 ? ` (+${extras.join(' +')})` : '';
		const result = await confirm({
			message: `Proceed with update to version ${newVersion}?${suffix}`,
			active: 'Yes',
			inactive: 'No',
		});
		if (isCancel(result) || !result) {
			console.log('\x1b[33m◆ Aborted.\x1b[0m');
			process.exit(0);
		}
	}

	// ── Phase 3: Execute ─────────────────────────────────────────────────────
	log();
	if (!hasUncommittedChanges) {
		log('workingDirClean');
	}
	log('newVersion', { from: currentVersion, to: newVersion });
	log();

	log('updatingPackageJson');
	if (!dryRun) {
		const packagePath = path.join(process.cwd(), 'package.json');
		const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
		packageJson.version = newVersion;
		if (options.pm === false) {
			delete packageJson.packageManager;
		} else if (!options.ignorePm) {
			packageJson.packageManager = detectPackageManager();
		}
		fs.writeFileSync(
			packagePath,
			`${JSON.stringify(packageJson, null, '\t')}\n`,
		);
	}
	if (options.pm === false) {
		log('packageManagerRemoved');
	} else if (options.ignorePm) {
		log('packageManagerUnchanged');
	} else {
		log('packageManagerSet', { pm: detectPackageManager() });
	}

	log('committing');
	if (!dryRun) {
		if (hasUncommittedChanges) {
			execSync('git add .', { stdio: 'pipe' });
		} else {
			execSync('git add package.json pnpm-lock.yaml', { stdio: 'pipe' });
		}
		execSync(`git commit -m "Release version ${newVersion}"`, {
			stdio: 'pipe',
		});
	}
	log('committed');

	if (createTag) {
		log('creatingTag', { version: newVersion });
		if (!dryRun) {
			execSync(`git tag v${newVersion}`, { stdio: 'pipe' });
		}
		log('tagCreated', { version: newVersion });
	}

	if (pushToRemote) {
		log('pushing');
		if (!dryRun) {
			execSync('git push origin main', { stdio: 'pipe' });
			if (createTag) {
				execSync(`git push origin v${newVersion}`, { stdio: 'pipe' });
			}
		}
		log('pushed', { withTag: String(createTag), version: newVersion });
	}

	// ── Final summary ────────────────────────────────────────────────────────
	if (isNonInteractive) {
		const extras: string[] = [];
		if (createTag) extras.push('tag');
		if (pushToRemote) extras.push('push');
		if (!verbose) {
			log('summary', { from: currentVersion, to: newVersion, extras: extras.join(', ') });
		}
	} else {
		console.log();
		console.log(dryRun ? '=== Dry Run Complete ===' : '=== Release Complete ===');
		console.log(`Version: ${currentVersion} → ${newVersion}`);
		if (createTag) console.log(`Tag:     #v${newVersion}`);
		if (pushToRemote) console.log(`Pushed:  ${createTag ? 'commit + tag' : 'commit only'}`);
		console.log();
	}
}

main().catch(console.error);
