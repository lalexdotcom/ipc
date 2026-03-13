//@ts-expect-error Types are wrong in @types/node-ipc package
import { IPCModule } from 'node-ipc';

import {
	CALL_COMMAND,
	DEFAULT_SERVER_ID,
	EVENT_COMMAND,
	REGISTER_COMMAND,
	RESPONSE_COMMAND,
} from './const';
import type {
	AddEventListenerFunction,
	CommandResultData,
	CommandRunData,
	CommandsCaller,
	CommandsDescriptor,
	EmitEventFunction,
	EndpointDescriptor,
	EventsDescriptor,
	IPCClient,
	RegisterCommandFunction,
	RegisterMessageData,
} from './types';

type IPC = typeof import('node-ipc');

export type Process<
	Endpoint extends EndpointDescriptor = EndpointDescriptor,
	Orchestrator extends EndpointDescriptor = EndpointDescriptor,
> = {
	readonly id: string;
	orchestrator: CommandsCaller<
		Orchestrator['commands'] extends CommandsDescriptor
			? Orchestrator['commands']
			: CommandsDescriptor
	> & {
		on: AddEventListenerFunction<
			Orchestrator['events'] extends EventsDescriptor
				? Orchestrator['events']
				: EventsDescriptor
		>;
	};
	emit: EmitEventFunction<
		Endpoint['events'] extends EventsDescriptor
			? Endpoint['events']
			: EventsDescriptor
	>;
	register: RegisterCommandFunction<
		Endpoint['commands'] extends CommandsDescriptor
			? Endpoint['commands']
			: CommandsDescriptor
	>;
};

export type ProcessEvents<P extends Process> =
	P extends Process<infer Endpoint, any>
		? Endpoint['events'] extends EventsDescriptor
			? Endpoint['events']
			: never
		: never;

export type ProcessCommands<P extends Process> =
	P extends Process<any, infer Orchestrator>
		? Orchestrator['commands'] extends CommandsDescriptor
			? Orchestrator['commands']
			: never
		: never;

/**
 * Creates a proxy object that allows a client process to call commands on the
 * IPC orchestrator as if they were local async functions.
 *
 * Each call is assigned a unique numeric ID registered in a pending-call map.
 * When the orchestrator sends back a RESPONSE_COMMAND message, the matching promise
 * is resolved (or rejected on error) and the entry is removed from the map.
 */
const createOrchestratorCommandCaller = <
	Commands extends CommandsDescriptor = CommandsDescriptor,
>(
	ipc: IPCClient,
) => {
	// Map of pending call IDs to their promise resolve/reject callbacks.
	const callRegistry: Record<
		number,
		{ resolve: (value: any) => void; reject: (reason?: any) => void }
	> = {};

	// Listen for command responses from the orchestrator and settle the matching promise.
	ipc.on(RESPONSE_COMMAND, (response: CommandResultData) => {
		const handler = callRegistry[response.id];
		if (handler) {
			delete callRegistry[response.id];
			if (response.error) {
				handler.reject(new Error(response.error));
			} else {
				handler.resolve(response.result);
			}
		}
	});

	// Monotonically increasing counter used to generate unique call IDs.
	let nextCallId = 1;

	// Return a Proxy so any property access becomes a callable async function
	// that transparently sends a CALL_COMMAND message to the orchestrator.
	return new Proxy(
		{},
		{
			get(target, prop: string) {
				if (Reflect.has(target, prop)) {
					return Reflect.get(target, prop);
				}
				if (prop === 'then') return undefined; // Prevent Promise.resolve() from treating this as a thenable
				return (...args: any[]) =>
					new Promise((resolve, reject) => {
						const callMessage: CommandRunData = {
							id: nextCallId++,
							command: prop,
							args,
						};

						callRegistry[callMessage.id] = { resolve, reject };
						ipc.emit(CALL_COMMAND, callMessage);
					});
			},
		},
	) as CommandsCaller<Commands>;
};

/**
 * Creates an `addEventListener`-style function that lets a client process
 * subscribe to typed events emitted by the orchestrator.
 *
 * Handlers for each event type are stored in a Set so multiple listeners can
 * coexist. The returned unsubscribe function removes the specific handler and
 * cleans up the Set when it becomes empty.
 */
const createOrchestratorAddListener = <
	Events extends EventsDescriptor = EventsDescriptor,
>(
	ipc: IPCClient,
) => {
	// Registry mapping event type names to the set of active handler functions.
	const eventHandlers: Record<string, Set<(...args: any[]) => void>> = {};

	// Dispatch incoming EVENT_COMMAND messages to all registered handlers for that type.
	ipc.on(EVENT_COMMAND, (message: { type: string; params: any[] }) => {
		const handlers = eventHandlers[message.type];
		if (handlers) {
			for (const handler of handlers) {
				handler(...message.params);
			}
		}
	});

	// Subscribe a handler to a given event type and return an unsubscribe function.
	const addListener: AddEventListenerFunction<Events> = (event, handler) => {
		if (!eventHandlers[event]) {
			eventHandlers[event] = new Set();
		}
		eventHandlers[event].add(handler);
		return () => {
			eventHandlers[event].delete(handler);
			// Remove the Set entirely when there are no remaining listeners.
			if (eventHandlers[event].size === 0) {
				delete eventHandlers[event];
			}
		};
	};

	return addListener;
};

/**
 * Creates a function that registers local command handlers on a child process.
 *
 * When a CALL_COMMAND message arrives from the orchestrator, the matching handler is
 * invoked with the provided arguments. The result (or any thrown error) is sent
 * back to the orchestrator via a RESPONSE_COMMAND message carrying the original call ID.
 */
const createRegisterCommand = <
	Commands extends CommandsDescriptor = CommandsDescriptor,
>(
	ipc: IPCClient,
) => {
	// Map of registered command names to their handler functions.
	const commandHandlers: Record<string, (...args: any[]) => any> = {};

	// Handle incoming command calls from the orchestrator.
	ipc.on(CALL_COMMAND, async (message: CommandRunData) => {
		const { id, command, args } = message;
		const handler = commandHandlers[command];
		if (handler) {
			try {
				const result = await handler(...args);
				ipc.emit(RESPONSE_COMMAND, { id, result });
			} catch (error) {
				// Serialize the error message so it can be sent over IPC.
				ipc.emit(RESPONSE_COMMAND, {
					id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} else {
			// No handler registered for this command; reply with an error.
			ipc.emit(RESPONSE_COMMAND, { id, error: `Unknown command: ${command}` });
		}
	});

	// Register a handler function under the given command name.
	const register: RegisterCommandFunction<Commands> = (command, handler) => {
		commandHandlers[command] = handler;
	};

	return register;
};

/**
 * Creates a typed event-emit function that broadcasts events to the orchestrator.
 *
 * Each call wraps the event type and its arguments into an EVENT_COMMAND
 * message sent over the IPC channel.
 */
const createEventEmitter = <Events extends EventsDescriptor = EventsDescriptor>(
	ipc: IPCClient,
) => {
	const emit: EmitEventFunction<Events> = (event, ...args) => {
		ipc.emit(EVENT_COMMAND, { type: event, params: args });
	};

	return emit;
};

type CreateProcessOptions = {
	/** Unique identifier for this process on the IPC channel. Defaults to an auto-generated ID. */
	id?: string;
	/** Optional group label used to logically cluster related processes. */
	group?: string;
	/** Name of the IPC orchestrator to connect to. Defaults to DEFAULT_SERVER_NAME. */
	orchestrator?: string;
	/** Map of command names to handler functions registered immediately on connection. */
	commands?: CommandsDescriptor;
};

// Global counter used to generate unique channel IDs when none is provided.
let nextProcessIndex = 1;

/**
 * Connects the current process to an IPC orchestrator and returns a set of
 * communication primitives:
 *
 * - `orchestrator` — Proxy to call commands on the orchestrator (with `.on` for events).
 * - `emit`         — Function to emit typed events to the orchestrator.
 * - `register`     — Function to expose commands that the orchestrator can invoke.
 *
 * The process is automatically registered with the orchestrator upon connection,
 * and any commands provided in the options are registered immediately.
 */
export const createProcess = <
	Endpoint extends EndpointDescriptor = EndpointDescriptor,
	Orchestrator extends EndpointDescriptor = EndpointDescriptor,
>(
	name: string,
	{
		id,
		group,
		orchestrator = DEFAULT_SERVER_ID,
		commands,
	}: CreateProcessOptions = {},
) => {
	// Build a unique channel ID if none was explicitly provided.
	const channelId =
		id ?? `process-${orchestrator}-${process.pid}-${nextProcessIndex++}`;
	const ipc = new IPCModule() as IPC;
	ipc.config.id = channelId;
	ipc.config.silent = true; // Suppress IPC library's internal log output.

	return new Promise<Process<Endpoint, Orchestrator>>((resolve, reject) => {
		ipc.connectTo(orchestrator, () => {
			const client = ipc.of[orchestrator];
			client.on('connect', () => {
				// Initialise all communication helpers on top of the raw IPC client.
				const orchestratorCommands = createOrchestratorCommandCaller(client);
				const orchestratorListener = createOrchestratorAddListener(client);
				const eventEmitter = createEventEmitter(client);
				const commandRegister = createRegisterCommand(client);

				// Announce this process to the server so it can be tracked.
				const message: RegisterMessageData = {
					id: channelId,
					pid: process.pid,
					name,
					group,
				};

				client.emit(REGISTER_COMMAND, message);

				// Register any commands that were provided at construction time.
				for (const [command, commandHandler] of Object.entries(
					commands ?? {},
				)) {
					commandRegister(command, commandHandler);
				}

				resolve({
					id: channelId,
					// Merge command caller and event listener under a single `orchestrator` object.
					orchestrator: Object.assign(orchestratorCommands, {
						on: orchestratorListener,
					}),
					emit: eventEmitter,
					register: commandRegister,
				});
			});
			client.on('error', (err: any) => {
				reject(err);
			});
		});
	});
};
