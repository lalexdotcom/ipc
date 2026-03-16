# @lalex/ipc

A TypeScript library for typed Inter-Process Communication (IPC) between Node.js processes. Built on top of [`node-ipc`](https://www.npmjs.com/package/node-ipc), it provides a clean RPC-style API with bidirectional command calls, typed event pub/sub, and process group filtering.

## Table of contents

- [Installation](#installation)
- [Concepts](#concepts)
- [Quick start](#quick-start)
- [API reference](#api-reference)
  - [createOrchestrator](#createorchestrator)
  - [createProcess](#createprocess)
- [TypeScript generics](#typescript-generics)
- [Development](#development)

---

## Installation

```bash
npm install @lalex/ipc
# or
pnpm add @lalex/ipc
```

---

## Concepts

`@lalex/ipc` is built around two roles:

- **Orchestrator** — an IPC server that manages a pool of connected processes. It can call commands on individual processes, broadcast events (optionally to a filtered subset by `id` or `group`), and listen to events emitted by any process.
- **Process** — an IPC client that connects to the orchestrator. It can register commands callable by the orchestrator, emit events, and call commands on the orchestrator.

Communication is fully bidirectional:

```
Orchestrator  ←──events──►  Process
              ←──commands──►
```

---

## Quick start

### Orchestrator (server)

```ts
import { createOrchestrator } from '@lalex/ipc';

const orch = await createOrchestrator({
  // Optional: expose commands that any connected process can call
  commands: {
    getStatus() {
      return 'orchestrator is ok';
    },
  },
});

// Listen for events emitted by any connected process
orch.on('greeting', (process, message) => {
  console.log(`[${process.name}] says: ${message}`);
});

// Listen only for events from a specific group
orch.on({ group: 'workers' }, 'ready', (process) => {
  console.log(`Worker ${process.id} is ready`);
});

// Broadcast an event to all connected processes
orch.emit('start', { config: {} });

// Broadcast to a filtered subset of processes
orch.emit({ group: 'workers' }, 'start', { config: {} });

// Call a command on a specific process
const result = await orch.process(processId)?.getStatus();
```

### Process (client)

```ts
import { createProcess } from '@lalex/ipc';

const proc = await createProcess('my-worker', {
  group: 'workers',
  // Optional: expose commands that the orchestrator can call
  commands: {
    getStatus() {
      return 'process is ok';
    },
  },
});

// Call a command on the orchestrator
const status = await proc.orchestrator.getStatus();

// Listen for events emitted by the orchestrator
proc.orchestrator.on('start', ({ config }) => {
  console.log('Starting with config:', config);
});

// Emit an event to the orchestrator
proc.emit('ready');

// Register an additional command at any time
proc.register('ping', () => 'pong');
```

---

## API reference

### `createOrchestrator`

```ts
createOrchestrator(options?: CreateOrchestratorOptions): Promise<Orchestrator>
```

Creates and starts an IPC server. Returns a promise that resolves once the server is ready to accept connections.

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | `string` | `'backend'` | IPC channel identifier. Must match the `orchestrator` option of connecting processes. |
| `commands` | `CommandsDescriptor` | `{}` | Map of command names to handler functions exposed to all connected processes. |

#### Orchestrator API

| Member | Signature | Description |
|--------|-----------|-------------|
| `id` | `string` | The channel ID of the orchestrator. |
| `process` | `(id: string) => ProcessWrapper \| undefined` | Returns the wrapper for a process by its unique ID, or `undefined` if not found. |
| `processes` | `(filter?: ProcessFilter) => IteratorObject<ProcessWrapper>` | Returns all registered process wrappers, optionally filtered. |
| `emit` | `(event, ...args) => void` | Broadcasts an event to **all** connected processes. |
| `emit` | `(filter, event, ...args) => void` | Broadcasts an event to processes matching the `ProcessFilter`. |
| `on` | `(event, handler) => unsubscribe` | Subscribes to an event emitted by **any** process. The handler receives the emitting `ProcessWrapper` as its first argument. |
| `on` | `(filter, event, handler) => unsubscribe` | Subscribes to an event, but only from processes matching the `ProcessFilter`. |
| `register` | `(command, handler) => void` | Registers a new command on the orchestrator at any time after startup. |

#### ProcessWrapper API

A process wrapper is obtained via `orch.process(id)` or via the handler argument in `orch.on(...)`. It exposes:

| Member | Signature | Description |
|--------|-----------|-------------|
| `id` | `string` | Unique channel ID of the process. |
| `pid` | `number` | OS process ID. |
| `name` | `string` | Human-readable name provided at process creation. |
| `group` | `string \| undefined` | Optional group the process belongs to. |
| `emit` | `(event, ...args) => void` | Sends an event directly to this process. |
| `on` | `(event, handler) => unsubscribe` | Subscribes to events emitted specifically by this process. |
| `[command]` | `(...args) => Promise<result>` | Calls a registered command on the process (RPC). |

#### ProcessFilter

```ts
type ProcessFilter = {
  id?: string | string[];    // Match by one or more process IDs
  group?: string | string[]; // Match by one or more group names
};
```

---

### `createProcess`

```ts
createProcess<Endpoint, Orchestrator>(
  name: string,
  options?: CreateProcessOptions,
): Promise<Process<Endpoint, Orchestrator>>
```

Connects the current process to an IPC orchestrator. Returns a promise that resolves once the connection is established and the process is registered.

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Human-readable name for this process (visible to the orchestrator). |

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | `string` | Auto-generated | Unique identifier for this process on the IPC channel. |
| `group` | `string` | — | Optional group label used to logically cluster related processes. |
| `orchestrator` | `string` | `'backend'` | ID of the orchestrator to connect to. Must match the orchestrator's `id`. |
| `commands` | `CommandsDescriptor` | — | Map of command names to handler functions registered immediately on connection. |

#### Process API

| Member | Signature | Description |
|--------|-----------|-------------|
| `id` | `string` | Unique channel ID of this process. |
| `orchestrator` | `CommandsCaller & { on }` | Proxy to call commands on the orchestrator as async functions. Also exposes `.on(event, handler)` to subscribe to orchestrator events. |
| `emit` | `(event, ...args) => void` | Emits a typed event to the orchestrator. |
| `register` | `(command, handler) => void` | Registers a command handler callable by the orchestrator. |

---

## TypeScript generics

Both `createOrchestrator` and `createProcess` accept `EndpointDescriptor` generic parameters for full compile-time type safety.

```ts
type EndpointDescriptor = {
  commands?: Record<string, (...args: any[]) => unknown>;
  events?: Record<string, any[]>; // each key maps to the tuple of event arguments
};
```

### Example

```ts
// Define your contracts
type WorkerEndpoint = {
  commands: {
    getStatus(): string;
    processItem(id: number): { success: boolean };
  };
  events: {
    ready: [];
    progress: [percent: number];
  };
};

type OrchestratorEndpoint = {
  commands: {
    getConfig(): { timeout: number };
  };
  events: {
    start: [config: { timeout: number }];
    stop: [];
  };
};

// Fully typed process
const proc = await createProcess<WorkerEndpoint, OrchestratorEndpoint>('worker', {
  group: 'workers',
});

// Type-safe orchestrator command call
const config = await proc.orchestrator.getConfig(); // returns { timeout: number }

// Type-safe event listener
proc.orchestrator.on('start', (config) => { /* config is { timeout: number } */ });

// Type-safe event emission
proc.emit('progress', 42); // ✓
proc.emit('progress', 'not-a-number'); // ✗ TypeScript error
```

---

## Development

Install dependencies:

```bash
pnpm install
```

| Command | Description |
|---------|-------------|
| `pnpm run build` | Build the library for production |
| `pnpm run dev` | Watch mode — rebuild on changes |
| `pnpm run test` | Run the test suite with Rstest |
| `pnpm run test:watch` | Run tests in watch mode |
| `pnpm run lint` | Lint the codebase with Biome |
| `pnpm run format` | Format the codebase with Biome |
