import type { Socket } from 'node:net';
import { json } from 'node:stream/consumers';
//@ts-expect-error Types are wrong in @types/node-ipc package
import { IPCModule } from 'node-ipc';
import jsonHash from 'safe-stable-stringify';
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
	EventData,
	EventsDescriptor,
	ProcessInfos,
	RegisterCommandFunction,
} from './types';

type IPC = typeof import('node-ipc');
type IPCClient = IPC['of'][string];
type IPCServer = IPC['server'];

type Process = ReturnType<typeof createSocketProcessWrapper>;

export type ProcessFilter = {
	id?: ProcessInfos['id'] | ProcessInfos['id'][];
	group?: ProcessInfos['group'] | ProcessInfos['group'][];
};

export type Orchestrator<
	Endpoint extends EndpointDescriptor = EndpointDescriptor,
> = {
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

export type OrchestratorCommands<O extends Orchestrator> =
	O extends Orchestrator<infer Endpoint>
		? Endpoint['commands'] extends CommandsDescriptor
			? Endpoint['commands']
			: never
		: never;

export type OrchestratorEvents<O extends Orchestrator> =
	O extends Orchestrator<infer Endpoint>
		? Endpoint['events'] extends EventsDescriptor
			? Endpoint['events']
			: never
		: never;

type CreateOrchestratorOptions = {
	/** IPC server ID / channel identifier. Defaults to DEFAULT_SERVER_ID. */
	id?: string;
	/** Map of command names to handler functions exposed to connected processes. */
	commands?: CommandsDescriptor;
};

const REGISTERED_PROCESS_EVENT = 'registered';
const LOST_PROCESS_EVENT = 'disconnected';

const createSocketProcessWrapper = (
	server: IPCServer,
	socket: Socket,
	infos: ProcessInfos,
	listener: ReturnType<typeof createSocketEventListener>,
) => {
	const caller = createSocketCommandCaller(server, socket);

	return Object.assign(caller, {
		...infos,
		on: listener.bind(null, socket),
	});
};

// Proxy that converts any property access into an async RPC call to the
// child process. Each call is registered in callRegistry so the response
// handler can settle the correct promise.
const createSocketCommandCaller = <
	Commands extends CommandsDescriptor = CommandsDescriptor,
>(
	server: IPCServer,
	socket: Socket,
) => {
	// Map of pending call IDs to their promise resolve/reject callbacks.
	const callRegistry: Record<
		number,
		{ resolve: (value: any) => void; reject: (reason?: any) => void }
	> = {};

	// Listen for command responses from the process and settle the matching promise.
	server.on(RESPONSE_COMMAND, (response: CommandResultData) => {
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

	return new Proxy(
		{},
		{
			get(target, prop: string) {
				if (Reflect.has(target, prop)) {
					return Reflect.get(target, prop);
				}
				if (prop === 'type') return undefined;
				if (prop === 'then') return undefined; // Prevent Promise.resolve() from treating this as a thenable
				return (...args: any[]) =>
					new Promise((resolve, reject) => {
						const callMessage: CommandRunData = {
							id: nextCallId++,
							command: prop,
							args,
						};
						callRegistry[callMessage.id] = { resolve, reject };
						server.emit(socket, CALL_COMMAND, callMessage);
					});
			},
		},
	) as CommandsCaller<Commands>;
};

const createSocketEventListener = (server: IPCServer) => {
	// Map of event types to Sets of handler functions for this socket.
	const eventListeners: Map<
		Socket,
		Record<string, Set<(...args: any[]) => void>>
	> = new Map();

	const addListener = (
		socket: Socket,
		event: string,
		handler: (...args: any[]) => void,
	) => {
		if (!eventListeners.get(socket)) {
			eventListeners.set(socket, {});
		}
		if (!eventListeners.get(socket)![event]) {
			eventListeners.get(socket)![event] = new Set();
		}
		eventListeners.get(socket)![event].add(handler);
		return () => {
			eventListeners.get(socket)?.[event]?.delete(handler);
			if (eventListeners.get(socket)?.[event]?.size === 0) {
				delete eventListeners.get(socket)![event];
			}
			if (Object.keys(eventListeners.get(socket)!).length === 0) {
				eventListeners.delete(socket);
			}
		};
	};

	// Listen for events from the process and dispatch them to the registered handlers.
	server.on(EVENT_COMMAND, ({ type, params }: EventData, socket: Socket) => {
		if (eventListeners.get(socket)?.[type]) {
			for (const handler of eventListeners.get(socket)![type]) {
				handler(...params);
			}
		}
	});

	return addListener;
};

/**
 * Creates and starts an IPC orchestrator server that manages multiple child
 * processes connected over a named IPC channel.
 *
 * The orchestrator provides:
 * - **Process registry** — tracks every connected process by socket and ID.
 * - **Event routing** — delivers events emitted by processes to global listeners,
 *   per-process (socket) listeners, and filter-based listeners.
 * - **Broadcast** — sends events to all processes or to a filtered subset.
 *
 * Returns a Promise that resolves with the orchestrator API once the orchestrator is
 * ready to accept connections.
 */
export const createOrchestrator = ({
	id = DEFAULT_SERVER_ID,
	commands = {},
}: CreateOrchestratorOptions = {}) => {
	type Process = ReturnType<typeof createProcessWrapper>;

	const ipc = new IPCModule() as IPC;

	// Primary registry: maps each raw socket to its Process wrapper (or undefined
	// while the REGISTER_COMMAND handshake has not yet been received).
	const registeredProcesses: Map<Socket, Process | undefined> = new Map();
	// Secondary index for O(1) lookup of a process by its string ID.
	const registeredProcessesById: Map<string, Socket> = new Map();

	/** Returns all currently registered Process wrappers that satisfy the filter. */
	const getRegisteredProcesses = (filter?: ProcessFilter) => {
		return registeredProcesses
			.values()
			.filter(
				filter
					? (prc) => prc !== undefined && processMatch(prc, filter!)
					: Boolean,
			) as IteratorObject<Process>;
	};

	/**
	 * Returns true when the process satisfies all non-undefined criteria in the
	 * filter. Array values are treated as an inclusion list (OR semantics).
	 */
	const processMatch = (prc: Process, filter: ProcessFilter) => {
		return (
			(filter.id === undefined ||
				(Array.isArray(filter.id)
					? filter.id.includes(prc.id)
					: filter.id === prc.id)) &&
			(filter.group === undefined ||
				(Array.isArray(filter.group)
					? filter.group.includes(prc.group)
					: filter.group === prc.group))
		);
	};

	// Global event listeners: invoked for every process that emits a given event.
	const globalListeners: Record<
		string,
		Set<(process: Process, ...args: any[]) => void>
	> = {};

	/**
	 * Subscribes a handler to a named event emitted by **any** connected process.
	 * The handler receives the emitting Process as its first argument.
	 * Returns an unsubscribe function.
	 */
	const addGlobalListener = (
		type: string,
		handler: (process: Process, ...args: any[]) => void,
	) => {
		if (!globalListeners[type]) {
			globalListeners[type] = new Set();
		}
		globalListeners[type].add(handler);
		return () => {
			globalListeners[type].delete(handler);
			// Clean up the Set when all listeners have been removed.
			if (globalListeners[type].size === 0) {
				delete globalListeners[type];
				return;
			}
		};
	};

	// Filter-based event listeners: invoked only when the emitting process matches
	// the filter encoded in the map key (filterHash -> listeners).
	const filterListeners: Record<
		string,
		Record<string, Set<(...args: any[]) => void>>
	> = {};

	/**
	 * Subscribes a handler to a named event, but only for processes that match
	 * the given filter (by id and/or group). The filter is serialised into a
	 * stable hash used as the inner Map key so identical filters share the same
	 * listener set.
	 * Returns an unsubscribe function.
	 */
	const addFilteredListener = (
		filter: ProcessFilter,
		type: string,
		handler: (process: Process, ...args: any[]) => void,
	) => {
		if (Object.keys(filter).length) {
			if (!filterListeners[type]) {
				filterListeners[type] = {};
			}
			const filterHash = jsonHash(filter);
			if (!filterListeners[type][filterHash]) {
				filterListeners[type][filterHash] = new Set();
			}
			filterListeners[type][filterHash].add(handler);
			return () => {
				const listeners = filterListeners[type][filterHash];
				if (listeners) {
					listeners.delete(handler);
					// Remove the inner Set when it becomes empty.
					if (listeners.size === 0) {
						delete filterListeners[type][filterHash];
						if (Object.keys(filterListeners[type]).length === 0) {
							delete filterListeners[type];
						}
					}
				}
				if (Object.keys(filterListeners[type]).length === 0) {
					delete filterListeners[type];
				}
			};
		} else return addGlobalListener(type, handler);
	};

	// Per-socket event listeners: invoked only for events from a specific process.
	const socketListeners: Record<
		string,
		Map<Socket, Set<(...args: any[]) => void>>
	> = {};

	const addSocketListener = (
		socket: Socket,
		type: string,
		handler: (...args: any[]) => void,
	) => {
		if (!socketListeners[type]) {
			socketListeners[type] = new Map();
		}
		if (!socketListeners[type].has(socket)) {
			socketListeners[type].set(socket, new Set());
		}
		socketListeners[type].get(socket)?.add(handler);
		return () => {
			socketListeners[type].get(socket)?.delete(handler);
			if (socketListeners[type].get(socket)?.size === 0) {
				socketListeners[type]?.delete(socket);
			}
			if (socketListeners[type]?.size === 0) {
				delete socketListeners[type];
			}
		};
	};

	const dispatchEvent = (socket: Socket, type: string, ...params: any[]) => {
		const prc = registeredProcesses.get(socket);
		if (!prc) {
			console.warn('Received event from unregistered process:', type, params);
			return;
		}
		// 1. Listeners registered on the specific process wrapper via `orchestrator.process(...).on`.
		if (socketListeners[type]?.get(socket)?.size) {
			for (const listener of socketListeners[type].get(socket) ?? []) {
				listener(...params);
			}
		}

		// 2. Global listeners registered via `orchestrator.on`.
		if (globalListeners[type]) {
			for (const listener of globalListeners[type]) {
				listener(prc, ...params);
			}
		}

		// 3. Filter-based listeners registered via `orchestrator.processes(...).on`.
		if (filterListeners[type]) {
			for (const [filterHash, listeners] of Object.entries(
				filterListeners[type],
			)) {
				const filter = JSON.parse(filterHash) as ProcessFilter;
				if (processMatch(prc, filter)) {
					for (const listener of listeners) {
						listener(prc, ...params);
					}
				}
			}
		}
	};

	const socketCommandCalls: Map<
		Socket,
		Record<
			number,
			{ resolve: (value: any) => void; reject: (reason?: any) => void }
		>
	> = new Map();

	// Creates a Proxy that turns any property access into an async RPC call to the process over the given socket.
	const createSocketCommandCaller = (socket: Socket, server: IPCServer) => {
		return new Proxy(
			{},
			{
				get(target, prop: string) {
					if (Reflect.has(target, prop)) {
						return Reflect.get(target, prop);
					}
					if (prop === 'type') return undefined;
					if (prop === 'then') return undefined; // Prevent Promise.resolve() from treating this as a thenable
					return (...args: any[]) =>
						new Promise((resolve, reject) => {
							const callId = Date.now() + Math.random(); // Unique call ID
							if (!socketCommandCalls.has(socket)) {
								socketCommandCalls.set(socket, {});
							}
							socketCommandCalls.get(socket)![callId] = { resolve, reject };
							server.emit(socket, CALL_COMMAND, {
								id: callId,
								command: prop,
								args,
							} as CommandRunData);
						});
				},
			},
		) as CommandsCaller;
	};

	// Orchestrator command handlers that processes can invoke via CALL_COMMAND.
	const commandsRegistry: Record<string, (...args: any[]) => any> = {};

	/** Registers an orchestrator command handler callable by any connected process. */
	const registerCommand = (
		command: string,
		handler: (...args: any[]) => any,
	) => {
		commandsRegistry[command] = handler;
	};

	// Register any commands provided at construction time before the orchestrator starts.
	for (const [command, handler] of Object.entries(commands)) {
		registerCommand(command, handler);
	}

	/**
	 * Builds a Process wrapper around a raw socket.
	 *
	 * The wrapper exposes:
	 * - `emit`  — send a typed event to this specific process.
	 * - `on`    — subscribe to events emitted by this specific process.
	 * - A Proxy that turns any property access into an async RPC call sent to
	 *   the process via CALL_COMMAND and resolved when RESPONSE_COMMAND arrives.
	 * - The `ProcessInfos` fields (id, pid, name, group) spread directly.
	 */
	const createProcessWrapper = (
		socket: Socket,
		server: IPCServer,
		infos: ProcessInfos,
	) => {
		// Send a typed event to this specific process over its socket.
		const emit: EmitEventFunction = (type, ...args) => {
			const event: EventData = {
				type,
				params: args,
			};
			server.emit(socket, EVENT_COMMAND, event);
		};

		const caller = createSocketCommandCaller(socket, server);

		// Merge RPC caller, event helpers, and process metadata into one object.
		const prc = Object.assign(caller, {
			...infos,
			on: addSocketListener.bind(null, socket),
			emit,
		});
		return prc;
	};

	/** Returns the Process wrapper for the given channel ID, or undefined if not found. */
	const getProcess = (id: string) => {
		const idSocket = registeredProcessesById.get(id);
		if (idSocket) {
			return registeredProcesses.get(idSocket);
		}
	};

	const addListenerWithOptionalFilter: {
		(
			filter: ProcessFilter,
			type: string,
			handler: (process: Process, ...args: any[]) => void,
		): () => void;
		(
			type: string,
			handler: (process: Process, ...args: any[]) => void,
		): () => void;
	} = (
		filterOrType: ProcessFilter | string,
		typeOrHandler: string | ((process: Process, ...args: any[]) => void),
		handlerOrUndefined?: (process: Process, ...args: any[]) => void,
	) => {
		if (
			typeof filterOrType === 'string' &&
			typeof typeOrHandler === 'function'
		) {
			return addGlobalListener(filterOrType, typeOrHandler);
		} else if (
			typeof filterOrType === 'object' &&
			typeof typeOrHandler === 'string' &&
			typeof handlerOrUndefined === 'function'
		) {
			return addFilteredListener(
				filterOrType,
				typeOrHandler,
				handlerOrUndefined,
			);
		}
		return () => {};
	};

	const emitWithOptionalFilter: {
		(filter: ProcessFilter, type: string, ...args: any[]): void;
		(type: string, ...args: any[]): void;
	} = (
		filterOrType: string | ProcessFilter,
		typeOrFirstArg: string | any,
		...restArgs: any[]
	) => {
		const filter = typeof filterOrType === 'string' ? undefined : filterOrType;
		const type =
			typeof filterOrType === 'string' ? filterOrType : typeOrFirstArg;
		const args =
			typeof filterOrType === 'string'
				? [typeOrFirstArg, ...restArgs]
				: restArgs;
		for (const process of getRegisteredProcesses(filter)) {
			process.emit(type, ...args);
		}
	};

	// Public API surface returned once the server is ready.
	const orchestrator = {
		id: id,
		on: addListenerWithOptionalFilter,
		process: getProcess,
		processes: getRegisteredProcesses,
		emit: emitWithOptionalFilter,
		register: registerCommand,
	};

	return new Promise<typeof orchestrator>((resolve) => {
		ipc.config.id = id;
		ipc.config.silent = true; // Suppress IPC library's internal log output.

		ipc.serve(() => {
			// Track the new socket; the Process wrapper is created after REGISTER_COMMAND.
			ipc.server.on('connect', (socket) => {
				registeredProcesses.set(socket, undefined);
			});

			// Create the Process wrapper once the child process sends its metadata.
			ipc.server.on(REGISTER_COMMAND, (infos: ProcessInfos, socket: Socket) => {
				registeredProcesses.set(
					socket,
					createProcessWrapper(socket, ipc.server, infos),
				);
				registeredProcessesById.set(infos.id, socket);
				dispatchEvent(socket, REGISTERED_PROCESS_EVENT, infos);
			});

			// Remove all registry entries and socket-specific listeners on disconnect.
			ipc.server.on('socket.disconnected', (socket) => {
				const infos = registeredProcesses.get(socket);
				if (infos) {
					registeredProcessesById.delete(infos.id);
					// Clean up all per-socket listener sets for the disconnected socket.
					for (const listenersBySocket of Object.values(socketListeners)) {
						listenersBySocket.delete(socket);
					}
					dispatchEvent(socket, LOST_PROCESS_EVENT, infos);
				}
				registeredProcesses.delete(socket);
			});

			// Route an incoming event to the three listener categories in order:
			// socket-specific → global → filter-based.
			ipc.server.on(
				EVENT_COMMAND,
				({ type, params }: EventData, socket: Socket) => {
					dispatchEvent(socket, type, ...params);
				},
			);

			// Settle the pending promise for the matching server-to-process RPC call.
			ipc.server.on(
				RESPONSE_COMMAND,
				(response: CommandResultData, socket: Socket) => {
					const socketCallRegistry = socketCommandCalls.get(socket);
					if (socketCallRegistry) {
						const handler = socketCallRegistry[response.id];
						if (handler) {
							if (response.error) {
								handler.reject(new Error(response.error));
							} else {
								handler.resolve(response.result);
							}
							delete socketCallRegistry[response.id];
						}
					}
				},
			);

			// Execute an orchestrator command requested by a process and send back the result.
			ipc.server.on(
				CALL_COMMAND,
				async (message: CommandRunData, socket: Socket) => {
					const handler = commandsRegistry[message.command];
					if (handler) {
						try {
							const result = await handler(...message.args);
							ipc.server.emit(socket, RESPONSE_COMMAND, {
								id: message.id,
								result,
							});
						} catch (error) {
							// Serialize the error message before sending it over IPC.
							ipc.server.emit(socket, RESPONSE_COMMAND, {
								id: message.id,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					}
				},
			);

			resolve(orchestrator);
		});

		ipc.server.start();
	});
};
