export const RESPONSE_COMMAND = 'response';
export const CALL_COMMAND = 'call';
export const EVENT_COMMAND = 'event';
export const REGISTER_COMMAND = 'register';

export const DEFAULT_SERVER_ID = 'backend';

export const getProcessName = (pid = process.pid) => `cli-${pid}`;
