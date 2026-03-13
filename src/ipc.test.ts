import { describe, expect, it, rs } from '@rstest/core';
import { createOrchestrator, type ProcessFilter } from './orchestrator';
import { createProcess } from './process';

const createProcessEventHandlerPromise = (
	process: Awaited<ReturnType<typeof createProcess>>,
	event: string,
	timeout = 300, // A lot can be done in 300ms, so this should be a reasonable default timeout for tests to wait for an event to be handled.
) => {
	return new Promise<string>((resolve, reject) => {
		process.orchestrator.on(event, (message) => {
			resolve(message);
		});
		setTimeout(() => reject('not_handled'), timeout);
	});
};

const createOrchestratorProcessEventHandler = (
	process: NonNullable<
		ReturnType<Awaited<ReturnType<typeof createOrchestrator>>['process']>
	>,
	event: string,
	timeout = 300,
) => {
	return new Promise<string>((resolve, reject) => {
		process.on(event, (message) => {
			resolve(message);
		});
		setTimeout(() => reject('not_handled'), timeout);
	});
};

const createOrchestratorEventHandler = (
	orchestrator: Awaited<ReturnType<typeof createOrchestrator>>,
	event: string,
	filter?: ProcessFilter,
	timeout = 300,
) => {
	return new Promise<{ process: { id: string }; message: string }>(
		(resolve, reject) => {
			orchestrator.on(filter ?? {}, event, (process, message) => {
				resolve({ process, message });
			});
			setTimeout(() => reject('not_handled'), timeout);
		},
	);
};

import stringify from 'safe-stable-stringify';

describe('orchestrator', () => {
	const processCount = 10;
	/**
	 * Validates that the orchestrator correctly registers and tracks multiple
	 * child processes connecting over IPC. Ensures all processes are discoverable
	 * via the orchestrator API after their REGISTER_COMMAND handshake completes.
	 */
	it(`orchestrator handles ${processCount} process registration`, async () => {
		const orch = await createOrchestrator();

		const processes = await Promise.all(
			Array.from({ length: processCount }, (i) =>
				createProcess(`Test process ${i}`),
			),
		);

		await expect
			.poll(() =>
				processes.reduce((all, prc) => !!orch.process(prc.id) && all, true),
			)
			.toBe(true);
	});
});

describe('orchestrator => process', () => {
	/**
	 * Tests that the orchestrator can invoke remote commands on an individual
	 * process and receive the command result back via RPC (CALL_COMMAND/RESPONSE_COMMAND).
	 * Ensures type-safe command invocation works end-to-end.
	 */
	it('call process command from orchestrator', async () => {
		const orch = await createOrchestrator();

		const prc = await createProcess('Test process', {
			commands: {
				getStatus() {
					return 'process is ok';
				},
			},
		});
		await rs.waitUntil(() => orch.process(prc.id));

		await expect(orch.process(prc.id)!.getStatus()).resolves.toBe(
			'process is ok',
		);
	});

	/**
	 * Validates that errors thrown in process command handlers are properly
	 * serialized and transported back to the orchestrator, where they are
	 * re-thrown as Error instances for proper error handling.
	 */
	it('handle error thrown by process command called from orchestrator', async () => {
		const orch = await createOrchestrator();

		const prc = await createProcess('Test process', {
			commands: {
				getStatus() {
					throw new Error('something went wrong in process');
				},
			},
		});
		await rs.waitUntil(() => orch.process(prc.id));

		await expect(orch.process(prc.id)!.getStatus()).rejects.toThrow(
			'something went wrong in process',
		);
	});

	/**
	 * Tests that events emitted by orchestrator.processes().emit() are broadcast
	 * to all connected processes. Validates that each process receives the event
	 * exactly once and with the correct message payload.
	 */
	it('all processes handles event broadcasted to all processes', async () => {
		const orch = await createOrchestrator();
		const processes = await Promise.all([
			createProcess('Test process', { group: 'test' }),
			createProcess('Test process', { group: 'group' }),
			createProcess('Test process'),
		]);
		await rs.waitUntil(() => processes.every((prc) => orch.process(prc.id)));

		const [prc1, prc2, prc3] = processes;
		const eventPromise1 = createProcessEventHandlerPromise(prc1, 'greeting');
		const eventPromise2 = createProcessEventHandlerPromise(prc2, 'greeting');
		const eventPromise3 = createProcessEventHandlerPromise(prc3, 'greeting');
		orch.emit('greeting', 'ok');

		// All processes should receive the event since it's broadcasted to all connected processes.
		await Promise.all([
			expect(eventPromise1).resolves.toBe('ok'),
			expect(eventPromise2).resolves.toBe('ok'),
			expect(eventPromise3).resolves.toBe('ok'),
		]);
	});

	/**
	 * Validates that calling orchestrator.processes({}).emit() with an explicit
	 * empty filter object still broadcasts to all processes. This ensures that
	 * empty filters are treated equivalently to no filter (undefined).
	 */
	it('all processes handle event broadcasted with empty filter', async () => {
		const orch = await createOrchestrator();
		const processes = await Promise.all([
			createProcess('Test process', { group: 'test' }),
			createProcess('Test process', { group: 'group' }),
			createProcess('Test process'),
		]);
		await rs.waitUntil(() => processes.every((prc) => orch.process(prc.id)));

		const [prc1, prc2, prc3] = processes;
		const eventPromise1 = createProcessEventHandlerPromise(prc1, 'greeting');
		const eventPromise2 = createProcessEventHandlerPromise(prc2, 'greeting');
		const eventPromise3 = createProcessEventHandlerPromise(prc3, 'greeting');
		orch.emit({}, 'greeting', 'ok');

		// All processes should receive the event since it's broadcasted to all connected processes.
		await Promise.all([
			expect(eventPromise1).resolves.toBe('ok'),
			expect(eventPromise2).resolves.toBe('ok'),
			expect(eventPromise3).resolves.toBe('ok'),
		]);
	});

	/**
	 * Verifies targeted group filtering when broadcasting an event from the
	 * orchestrator to processes. Only processes in group `test` should handle
	 * the event, while non-matching processes should time out (`not_handled`).
	 */
	it('only matching processes handle event broadcasted to a specific group', async () => {
		const orch = await createOrchestrator();

		const processes = await Promise.all([
			createProcess('Test process', { group: 'test' }),
			createProcess('Test process', { group: 'test' }),
			createProcess('Test process'),
		]);
		await rs.waitUntil(() => processes.every((prc) => orch.process(prc.id)));

		const [prc1, prc2, prc3] = processes;
		const eventPromise1 = createProcessEventHandlerPromise(prc1, 'greeting');
		const eventPromise2 = createProcessEventHandlerPromise(prc2, 'greeting');
		const eventPromise3 = createProcessEventHandlerPromise(prc3, 'greeting');

		orch.emit({ group: 'test' }, 'greeting', 'ok');

		// The first and second processes should receive the event since they're in the targeted group, while the third process should ignore it.
		await Promise.all([
			expect(eventPromise1).resolves.toBe('ok'),
			expect(eventPromise2).resolves.toBe('ok'),
			expect(eventPromise3).rejects.toBe('not_handled'),
		]);
	});

	/**
	 * Verifies multi-group filtering logic for orchestrator broadcasts. Processes
	 * belonging to any group listed in the filter should receive the event, and
	 * processes outside that list should not handle it.
	 */
	it('only matching processes handle event broadcasted to multiple groups', async () => {
		const orch = await createOrchestrator();

		const processes = await Promise.all([
			createProcess('Test process', { group: 'test_1' }),
			createProcess('Test process', { group: 'test_2' }),
			createProcess('Test process', { group: 'test_3' }),
		]);
		await rs.waitUntil(() => processes.every((prc) => orch.process(prc.id)));

		const [prc1, prc2, prc3] = processes;
		const eventPromise1 = createProcessEventHandlerPromise(prc1, 'greeting');
		const eventPromise2 = createProcessEventHandlerPromise(prc2, 'greeting');
		const eventPromise3 = createProcessEventHandlerPromise(prc3, 'greeting');

		orch.emit({ group: ['test_1', 'test_2'] }, 'greeting', 'ok');

		// The first and second processes should receive the event since they're in the targeted groups, while the third process should ignore it.
		await Promise.all([
			expect(eventPromise1).resolves.toBe('ok'),
			expect(eventPromise2).resolves.toBe('ok'),
			expect(eventPromise3).rejects.toBe('not_handled'),
		]);
	});

	/**
	 * Ensures ID-based targeting works for one specific process. The process
	 * whose `id` is explicitly selected must receive the message, and every
	 * other process should ignore it.
	 */
	it('only matching processes handle event broadcasted to a specific id', async () => {
		const orch = await createOrchestrator();

		const processes = await Promise.all([
			createProcess('Test process', { group: 'test' }),
			createProcess('Test process'),
			createProcess('Test process'),
		]);
		await rs.waitUntil(() => processes.every((prc) => orch.process(prc.id)));

		const [prc1, prc2, prc3] = processes;
		const eventPromise1 = createProcessEventHandlerPromise(prc1, 'greeting');
		const eventPromise2 = createProcessEventHandlerPromise(prc2, 'greeting');
		const eventPromise3 = createProcessEventHandlerPromise(prc3, 'greeting');

		orch.emit({ id: prc1.id }, 'greeting', 'ok');

		// Only the first process should receive the event since it's the only one with the targeted ID, while the second process should ignore it.
		await Promise.all([
			expect(eventPromise1).resolves.toBe('ok'),
			expect(eventPromise2).rejects.toBe('not_handled'),
			expect(eventPromise3).rejects.toBe('not_handled'),
		]);
	});

	/**
	 * Ensures ID-based targeting works for multiple explicit process IDs. Only
	 * the processes listed in the filter should receive the event payload.
	 */
	it('only matching processes handle event broadcasted to multiple ids', async () => {
		const orch = await createOrchestrator();

		const processes = await Promise.all([
			createProcess('Test process', { group: 'test' }),
			createProcess('Test process'),
			createProcess('Test process'),
		]);
		await rs.waitUntil(() => processes.every((prc) => orch.process(prc.id)));

		const [prc1, prc2, prc3] = processes;
		const eventPromise1 = createProcessEventHandlerPromise(prc1, 'greeting');
		const eventPromise2 = createProcessEventHandlerPromise(prc2, 'greeting');
		const eventPromise3 = createProcessEventHandlerPromise(prc3, 'greeting');

		orch.emit({ id: [prc1.id, prc2.id] }, 'greeting', 'ok');

		// Only the first and second processes should receive the event since they're the only ones with the targeted IDs, while the third process should ignore it.
		await Promise.all([
			expect(eventPromise1).resolves.toBe('ok'),
			expect(eventPromise2).resolves.toBe('ok'),
			expect(eventPromise3).rejects.toBe('not_handled'),
		]);
	});
});

describe('processes => orchestrator', () => {
	/**
	 * Validates that a process can invoke a command exposed by the orchestrator
	 * and receive the expected return value. This covers the reverse RPC path
	 * compared to orchestrator-to-process command calls.
	 */
	it('process calls orchestrator command', async () => {
		await createOrchestrator({
			commands: {
				getStatus() {
					return 'orchestrator is ok';
				},
			},
		});
		const clt = await createProcess('Test process');
		await expect(clt.orchestrator.getStatus()).resolves.toBe(
			'orchestrator is ok',
		);
	});

	/**
	 * Validates error propagation when a process calls an orchestrator command
	 * that throws. The process-side caller should receive a rejected promise
	 * with the original error message.
	 */
	it('process handle error thrown by orchestrator command call', async () => {
		await createOrchestrator({
			commands: {
				getStatus() {
					throw new Error('something went wrong in orchestrator');
				},
			},
		});
		const clt = await createProcess('Test process');
		await expect(clt.orchestrator.getStatus()).rejects.toThrow(
			'something went wrong in orchestrator',
		);
	});

	/**
	 * Ensures the orchestrator global event listener receives events emitted by
	 * connected processes, including the emitting process metadata and payload.
	 */
	it('orchestrator handles event emitted by any process', async () => {
		const orch = await createOrchestrator();
		const prc = await createProcess('Test process');

		await rs.waitUntil(() => orch.process(prc.id));

		const eventPromise = createOrchestratorEventHandler(orch, 'greeting');
		prc.emit('greeting', 'hi');

		await expect(eventPromise).resolves.toMatchObject({
			process: { id: prc.id },
			message: 'hi',
		});
	});

	/**
	 * Verifies process-to-orchestrator event filtering by a single group value.
	 * Handlers configured for matching groups should resolve, while handlers for
	 * non-matching groups should not be invoked.
	 */
	it('orchestrator handles event emitted by a process matching a specific group', async () => {
		const orch = await createOrchestrator();

		const prc = await createProcess('Test 1', { group: 'test_1' });
		await rs.waitUntil(() => orch.process(prc.id));

		const test1EventPromise = createOrchestratorEventHandler(orch, 'greeting', {
			group: 'test_1',
		});
		const test2EventPromise = createOrchestratorEventHandler(orch, 'greeting', {
			group: 'test_2',
		});

		// Only the first process should trigger the event handler since it's the only one in the targeted group.
		prc.emit('greeting', 'hi');

		await Promise.all([
			expect(test1EventPromise).resolves.toMatchObject({
				process: { id: prc.id },
				message: 'hi',
			}),
			expect(test2EventPromise).rejects.toBe('not_handled'),
		]);
	});

	/**
	 * Verifies process-to-orchestrator event filtering by multiple accepted
	 * groups. A handler with a filter that includes the process group should
	 * resolve, while unrelated group filters should remain unhandled.
	 */
	it('orchestrator only handles event emitted by a process matching multiple groups', async () => {
		const orch = await createOrchestrator();

		const prc = await createProcess('Test 1', { group: 'test_1' });
		await rs.waitUntil(() => orch.process(prc.id));

		const test1n2EventPromise = createOrchestratorEventHandler(
			orch,
			'greeting',
			{
				group: ['test_1', 'test_2'],
			},
		);
		const test2EventPromise = createOrchestratorEventHandler(orch, 'greeting', {
			group: 'test_2',
		});
		const test3EventPromise = createOrchestratorEventHandler(orch, 'greeting', {
			group: ['test_2', 'test_3'],
		});

		// Only the first process should trigger the event handler since it's the only one in the targeted group.
		prc.emit('greeting', 'hi');

		await Promise.all([
			expect(test1n2EventPromise).resolves.toMatchObject({
				process: { id: prc.id },
				message: 'hi',
			}),
			expect(test2EventPromise).rejects.toBe('not_handled'),
			expect(test3EventPromise).rejects.toBe('not_handled'),
		]);
	});

	/**
	 * Ensures process-specific listeners attached through `orch.process(id)`
	 * receive events emitted by that exact process instance.
	 */
	it('orchestrator handles event emitted by specific process', async () => {
		const orch = await createOrchestrator();
		const prc = await createProcess('Test process');

		await rs.waitUntil(() => orch.process(prc.id));

		const eventPromise = createOrchestratorProcessEventHandler(
			orch.process(prc.id)!,
			'greeting',
		);
		prc.emit('greeting', 'hi');

		await expect(eventPromise).resolves.toEqual('hi');
	});
});
