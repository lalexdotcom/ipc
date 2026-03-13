import type IPC from 'node-ipc';

export type IPCClient =
	typeof IPC.of extends Record<string, infer Client> ? Client : never;

export type IPCServer = typeof IPC.server;

export type EventData = {
	type: string;
	params: any[];
};

export type CommandRunData = {
	id: number;
	command: string;
	args: string[];
};

export type CommandResultData = {
	id: number;
	result: unknown;
	error?: string;
};

export type ProcessInfos = {
	id: string;
	pid: number;
	name: string;
	group?: string;
};

export type RegisterMessageData = {
	id: string;
	pid: typeof process.pid;
	name: string;
	group?: string;
};

export type CommandsDescriptor = Record<string, (...args: any[]) => unknown>;
export type EventsDescriptor = Record<string, any[]>;

export type EndpointDescriptor = {
	commands?: CommandsDescriptor;
	events?: EventsDescriptor;
};

export type EmitEventFunction<
	Events extends EventsDescriptor = EventsDescriptor,
> = <EventType extends (keyof Events & string) | (string & {})>(
	event: EventType,
	...args: EventType extends keyof Events ? Events[EventType] : any[]
) => void;

export type AddEventListenerFunction<
	Events extends EventsDescriptor = EventsDescriptor,
> = <EventType extends (keyof Events & string) | (string & {})>(
	event: EventType,
	handler: (
		...args: EventType extends keyof Events ? Events[EventType] : any[]
	) => void,
) => () => void;

export type RegisterCommandFunction<
	Commands extends CommandsDescriptor = CommandsDescriptor,
> = <CommandName extends (keyof Commands & string) | (string & {})>(
	command: CommandName,
	handler: CommandName extends keyof Commands
		? Commands[CommandName]
		: (...args: any[]) => any,
) => void;

export type CommandsCaller<
	Commands extends CommandsDescriptor = CommandsDescriptor,
> = {
	[K in keyof Commands]: (
		...args: Parameters<Commands[K]>
	) => Promise<Awaited<ReturnType<Commands[K]>>>;
};

export type GenericProcessEvents = {
	disconnected: [];
};

export type Orchestrator<Endpoint extends EndpointDescriptor> = {
	readonly id: string;
	emit: EmitEventFunction<
		Endpoint['events'] extends EventsDescriptor
			? Endpoint['events']
			: EventsDescriptor
	>;
};
