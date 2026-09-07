/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suite, test } from 'node:test';
import { load } from 'js-yaml';
import { testCheckpoint } from '../../azure-pipelines/common/testCheckpoint.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const helperPath = path.join(repositoryRoot, 'build/azure-pipelines/common/testCheckpoint.ts');
const reuseCondition = '${{ if eq(parameters.VSCODE_REUSE_SUCCESSFUL_TESTS, true) }}';
const unitTests = [
	{ id: 'unit-electron', command: './scripts/test.sh --build --tfs "Unit Tests"' },
	{ id: 'unit-node', command: 'npm run test-node -- --build' },
	{ id: 'unit-browser-chromium', command: 'npm run test-browser-no-install -- --build --browser chromium --tfs "Browser Unit Tests"' },
];

const environment: NodeJS.ProcessEnv = {
	AGENT_OS: 'Linux',
	VSCODE_ARCH: 'x64',
	BUILD_BUILDID: '123',
	BUILD_SOURCEVERSION: 'source-commit',
	SYSTEM_COLLECTIONURI: 'https://dev.azure.com/organization/',
	SYSTEM_TEAMPROJECTID: 'project-id',
	SYSTEM_STAGENAME: 'Linux',
	SYSTEM_JOBNAME: 'Linux_x64',
	SYSTEM_STAGEATTEMPT: '1',
	SYSTEM_JOBATTEMPT: '1',
	SYSTEM_ACCESSTOKEN: 'test-token',
};

function variables(messages: readonly string[]): Record<string, string> {
	return Object.fromEntries(messages.flatMap(message => {
		const match = /^##vso\[task.setvariable variable=(?<name>\w+)\](?<value>.*)$/.exec(message);
		return match?.groups ? [[match.groups.name, match.groups.value]] : [];
	}));
}

function artifactName(id: string): string {
	return `test-pass-v1-Linux-Linux_x64-linux-x64-${id}`;
}

interface TestStep {
	script?: string;
	condition?: string;
	template?: string;
	parameters?: { testId: string };
	[reuseCondition]?: TestStep | TestStep[];
	'${{ else }}'?: TestStep;
}

function testGroups(): TestStep[][] {
	const template = load(readFileSync(path.join(repositoryRoot, 'build/azure-pipelines/linux/steps/product-build-linux-test.yml'), 'utf8')) as {
		steps: Record<string, TestStep[]>[];
	};
	return [
		template.steps.find(step => Object.hasOwn(step, '${{ if eq(parameters.VSCODE_RUN_ELECTRON_TESTS, true) }}'))!['${{ if eq(parameters.VSCODE_RUN_ELECTRON_TESTS, true) }}'],
		template.steps.find(step => Object.hasOwn(step, '${{ if eq(parameters.VSCODE_RUN_BROWSER_TESTS, true) }}'))!['${{ if eq(parameters.VSCODE_RUN_BROWSER_TESTS, true) }}'],
	];
}

suite('Product test checkpoints', () => {
	test('restores only exact pipeline artifacts and resets readiness', async () => {
		const messages: string[] = [];
		let requestedUrl = '';
		const request: typeof fetch = async (url, options) => {
			requestedUrl = String(url);
			assert.deepStrictEqual(options?.headers, { Authorization: 'Bearer test-token', Accept: 'application/json' });
			return Response.json({ value: [
				{ name: artifactName('unit-electron'), resource: { type: 'PipelineArtifact' } },
				{ name: artifactName('unit-node'), resource: { type: 'Container' } },
				{ name: artifactName('unit-browser-chromium') + '-attempt1', resource: { type: 'PipelineArtifact' } },
				{ name: artifactName('unit-node').replace('Linux_x64', 'Linux_arm64'), resource: { type: 'PipelineArtifact' } },
				{ name: artifactName('unit-node').replace('test-pass-v1', 'test-pass-v2'), resource: { type: 'PipelineArtifact' } },
			] });
		};
		await testCheckpoint(['restore'], environment, request, message => messages.push(message));
		assert.deepStrictEqual({
			requestedUrl,
			variables: variables(messages),
			reused: messages.filter(message => message.startsWith('Reusing')),
		}, {
			requestedUrl: 'https://dev.azure.com/organization/project-id/_apis/build/builds/123/artifacts?api-version=7.1',
			variables: {
				TEST_CHECKPOINT_UNIT_ELECTRON_HIT: 'true',
				TEST_CHECKPOINT_UNIT_ELECTRON_READY: 'false',
				TEST_CHECKPOINT_UNIT_NODE_HIT: 'false',
				TEST_CHECKPOINT_UNIT_NODE_READY: 'false',
				TEST_CHECKPOINT_UNIT_BROWSER_CHROMIUM_HIT: 'false',
				TEST_CHECKPOINT_UNIT_BROWSER_CHROMIUM_READY: 'false',
			},
			reused: [`Reusing successful test unit-electron: ${artifactName('unit-electron')}`],
		});
	});

	test('job and stage attempts share names but a new run has its own lookup', async () => {
		const restored: { buildId: string; hit: string }[] = [];
		const request: typeof fetch = async url => Response.json({ value: String(url).includes('/builds/123/')
			? [{ name: artifactName('unit-electron'), resource: { type: 'PipelineArtifact' } }]
			: [] });
		for (const overrides of [
			{ SYSTEM_JOBATTEMPT: '2' },
			{ SYSTEM_JOBATTEMPT: '1', SYSTEM_STAGEATTEMPT: '3' },
			{ BUILD_BUILDID: '456' },
		]) {
			const env = { ...environment, ...overrides };
			const messages: string[] = [];
			await testCheckpoint(['restore'], env, request, message => messages.push(message));
			restored.push({ buildId: env.BUILD_BUILDID!, hit: variables(messages).TEST_CHECKPOINT_UNIT_ELECTRON_HIT });
		}
		assert.deepStrictEqual(restored, [
			{ buildId: '123', hit: 'true' },
			{ buildId: '123', hit: 'true' },
			{ buildId: '456', hit: 'false' },
		]);
	});

	for (const status of [401, 403, 429]) {
		test(`surfaces HTTP ${status} without treating it as a hit`, async () => {
			const messages: string[] = [];
			await assert.rejects(
				testCheckpoint(['restore'], environment, async () => new Response(null, { status }), message => messages.push(message)),
				new RegExp(`Unexpected status code: ${status}`),
			);
			assert.ok(Object.values(variables(messages)).every(value => value === 'false'));
		});
	}

	test('retries a transient server failure', async () => {
		let requests = 0;
		await testCheckpoint(['restore'], environment, async () => {
			return ++requests === 1 ? new Response(null, { status: 503 }) : Response.json({ value: [] });
		}, () => { });
		assert.equal(requests, 2);
	});

	for (const body of [{}, { value: null }, { value: [{ name: 'incomplete' }] }]) {
		test(`rejects malformed artifact response ${JSON.stringify(body)}`, async () => {
			await assert.rejects(testCheckpoint(['restore'], environment, async () => Response.json(body), () => { }), /Invalid pipeline artifact/);
		});
	}

	test('validates commands, pilot scope and identity before accessing the API', async () => {
		const request: typeof fetch = async () => { throw new Error('Unexpected network access'); };
		for (const args of [[], ['restore', 'extra'], ['record', '../escape'], ['record', 'unit-electron', 'extra']]) {
			await assert.rejects(testCheckpoint(args, environment, request), /Usage:/);
		}
		for (const overrides of [
			{ VSCODE_ARCH: 'arm64' },
			{ AGENT_OS: 'Windows_NT' },
			{ BUILD_BUILDID: '' },
			{ SYSTEM_JOBNAME: '../job' },
			{ SYSTEM_STAGENAME: 'stage\ninjection' },
			{ SYSTEM_COLLECTIONURI: 'http://dev.azure.com/org/' },
			{ SYSTEM_ACCESSTOKEN: '' },
		]) {
			await assert.rejects(testCheckpoint(['restore'], { ...environment, ...overrides }, request, () => { }), /supported|Missing|Invalid|HTTPS/);
		}
	});

	test('records metadata without a token and ignores local files during restore', async t => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'test-checkpoint-'));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const env = { ...environment, AGENT_TEMPDIRECTORY: directory, SYSTEM_JOBATTEMPT: '2', SYSTEM_ACCESSTOKEN: undefined };
		const recorded: string[] = [];
		const request: typeof fetch = async () => Response.json({ value: [] });
		await testCheckpoint(['record', 'unit-node'], env, request, message => recorded.push(message));
		const state = variables(recorded);
		const metadata: Record<string, unknown> = JSON.parse(readFileSync(state.TEST_CHECKPOINT_UNIT_NODE_FILE, 'utf8'));
		assert.deepStrictEqual({ ...metadata, completedAt: typeof metadata.completedAt === 'string' && Number.isFinite(Date.parse(metadata.completedAt)) }, {
			schemaVersion: 1,
			buildId: '123',
			sourceVersion: 'source-commit',
			stageName: 'Linux',
			jobName: 'Linux_x64',
			target: 'linux-x64',
			testId: 'unit-node',
			jobAttempt: 2,
			stageAttempt: 1,
			completedAt: true,
		});
		assert.deepStrictEqual(state, {
			TEST_CHECKPOINT_UNIT_NODE_FILE: path.join(directory, 'test-checkpoints/123/Linux/Linux_x64/1/2/unit-node/test-checkpoint.json'),
			TEST_CHECKPOINT_UNIT_NODE_ARTIFACT: artifactName('unit-node'),
			TEST_CHECKPOINT_UNIT_NODE_READY: 'true',
		});
		const restored: string[] = [];
		await testCheckpoint(['restore'], { ...env, SYSTEM_ACCESSTOKEN: 'test-token' }, request, message => restored.push(message));
		assert.equal(variables(restored).TEST_CHECKPOINT_UNIT_NODE_HIT, 'false');
	});

	test('metadata write failures cannot signal readiness', async () => {
		const messages: string[] = [];
		await assert.rejects(testCheckpoint(['record', 'unit-node'], {
			...environment, AGENT_TEMPDIRECTORY: helperPath,
		}, fetch, message => messages.push(message)));
		assert.deepStrictEqual(messages, []);
	});

	test('every parameter boundary defaults off and compile limits reuse to product x64', () => {
		const files = [
			'product-build.yml',
			'linux/product-build-linux.yml',
			'linux/steps/product-build-linux-compile.yml',
			'linux/steps/product-build-linux-test.yml',
		];
		const defaults = files.map(file => {
			const template = load(readFileSync(path.join(repositoryRoot, 'build/azure-pipelines', file), 'utf8')) as {
				parameters: { name: string; type: string; default?: boolean }[];
			};
			const parameter = template.parameters.find(parameter => parameter.name === 'VSCODE_REUSE_SUCCESSFUL_TESTS');
			return { file, type: parameter?.type, default: parameter?.default };
		});
		assert.deepStrictEqual(defaults, files.map(file => ({ file, type: 'boolean', default: false })));
		const compile = readFileSync(path.join(repositoryRoot, 'build/azure-pipelines/linux/steps/product-build-linux-compile.yml'), 'utf8');
		assert.ok(compile.includes('VSCODE_REUSE_SUCCESSFUL_TESTS: ${{ and(eq(parameters.VSCODE_REUSE_SUCCESSFUL_TESTS, true), eq(parameters.VSCODE_ARCH, \'x64\'), eq(parameters.VSCODE_CIBUILD, false)) }}'));
	});

	test('publisher requires success, explicit readiness and a restore miss', () => {
		const publisher = load(readFileSync(path.join(repositoryRoot, 'build/azure-pipelines/common/publish-test-checkpoint.yml'), 'utf8')) as { steps: object[] };
		const prefix = 'TEST_CHECKPOINT_${{ upper(replace(parameters.testId, \'-\', \'_\')) }}';
		assert.deepStrictEqual(publisher.steps, [{
			task: '1ES.PublishPipelineArtifact@1',
			inputs: {
				targetPath: `$(${prefix}_FILE)`,
				artifactName: `$(${prefix}_ARTIFACT)`,
				sbomEnabled: false,
				isProduction: false,
			},
			condition: `and(succeeded(), eq(variables['${prefix}_READY'], 'true'), ne(variables['${prefix}_HIT'], 'true'))`,
			displayName: 'Publish ${{ parameters.testId }} checkpoint',
			timeoutInMinutes: 2,
		}]);
	});

	test('each unit test has a guarded script and an immediate guarded publisher', () => {
		const groups = testGroups();
		const snapshots = groups.flatMap(group => group.flatMap((step, index) => {
			const enabled = step[reuseCondition];
			if (!enabled || Array.isArray(enabled) || !enabled.script) {
				return [];
			}
			const id = /record (?<id>[\w-]+)/.exec(enabled.script)?.groups?.id;
			const publisher = group[index + 1][reuseCondition];
			assert.ok(Array.isArray(publisher));
			return [{
				id,
				condition: enabled.condition,
				publisher: publisher[0],
				disabledScript: step['${{ else }}']?.script,
			}];
		}));
		assert.deepStrictEqual(snapshots, unitTests.map(({ id, command }) => ({
			id,
			condition: `and(succeeded(), ne(variables['TEST_CHECKPOINT_${id.replaceAll('-', '_').toUpperCase()}_HIT'], 'true'))`,
			publisher: { template: '../../common/publish-test-checkpoint.yml@self', parameters: { testId: id } },
			disabledScript: id === 'unit-node' ? `set -e\nmkdir -p .build/crashes\n${command}\n` : command,
		})));
	});

	test('synthetic failure is gated, follows unit checkpoints and only runs on the first non-publishing attempt', { skip: process.platform === 'win32' }, () => {
		const template = load(readFileSync(path.join(repositoryRoot, 'build/azure-pipelines/linux/steps/product-build-linux-test.yml'), 'utf8')) as {
			steps: (TestStep & { displayName?: string; [key: string]: unknown })[];
		};
		const gate = '${{ if and(eq(parameters.VSCODE_REUSE_SUCCESSFUL_TESTS, true), or(eq(parameters.VSCODE_RUN_ELECTRON_TESTS, true), eq(parameters.VSCODE_RUN_BROWSER_TESTS, true))) }}';
		const index = template.steps.findIndex(step => Array.isArray(step[gate])
			&& step[gate].some(child => child.displayName === 'Validate unit-test checkpoint retry (expected failure)'));
		assert.ok(index > 0);
		const [failure] = template.steps[index][gate] as (TestStep & { displayName: string })[];
		assert.deepStrictEqual({
			previousGroup: Object.keys(template.steps[index - 1]),
			nextStep: template.steps[index + 1].displayName,
			condition: failure.condition,
		}, {
			previousGroup: ['${{ if eq(parameters.VSCODE_RUN_BROWSER_TESTS, true) }}'],
			nextStep: 'Build integration tests',
			condition: 'and(succeeded(), eq(variables[\'VSCODE_PUBLISH\'], \'false\'), eq(variables[\'System.JobAttempt\'], \'1\'), eq(variables[\'System.StageAttempt\'], \'1\'))',
		});
		assert.ok(failure.script);
		const result = spawnSync('bash', ['-c', failure.script], { encoding: 'utf8' });
		assert.deepStrictEqual({
			status: result.status,
			stderr: result.stderr,
			expectedFailureLogged: result.stdout.includes('Intentional checkpoint validation failure'),
		}, { status: 1, stderr: '', expectedFailureLogged: true });
	});

	for (const { id, command } of unitTests) {
		test(`${id}: actual enabled shell only records after a successful runner`, { skip: process.platform === 'win32' }, t => {
			const directory = mkdtempSync(path.join(os.tmpdir(), 'test-checkpoint-shell-'));
			t.after(() => rmSync(directory, { recursive: true, force: true }));
			const enabled = testGroups().flat().map(step => step[reuseCondition])
				.find(step => step && !Array.isArray(step) && step.script?.includes(`record ${id}`));
			assert.ok(enabled && !Array.isArray(enabled) && enabled.script);
			const results = [17, 0].map(exitCode => {
				const script = enabled.script!.replace(command, `(exit ${exitCode})`)
					.replace('node build/azure-pipelines/common/testCheckpoint.ts', `"${process.execPath}" "${helperPath}"`);
				const result = spawnSync('bash', ['-c', script], {
					cwd: directory,
					env: { ...process.env, ...environment, AGENT_TEMPDIRECTORY: directory },
					encoding: 'utf8',
				});
				return {
					status: result.status,
					stderr: result.stderr,
					ready: result.stdout.includes('_READY]true'),
					fileExists: existsSync(path.join(directory, 'test-checkpoints/123/Linux/Linux_x64/1/1', id, 'test-checkpoint.json')),
				};
			});
			assert.deepStrictEqual(results, [
				{ status: 17, stderr: '', ready: false, fileExists: false },
				{ status: 0, stderr: '', ready: true, fileExists: true },
			]);
		});
	}
});
