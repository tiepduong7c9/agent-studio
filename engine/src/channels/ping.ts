import type { IServerChannel } from '../net.js';
import type { IChannel } from '../net.js';
import { Event } from '../vendor/vs/base/common/event.js';
import { CancellationToken } from '../vendor/vs/base/common/cancellation.js';

// Minimal channel used to prove the vendored IPC layer works end to end
// (P1 smoke test). It exercises both halves of the channel contract: a
// request/response `call` and an event `listen`.

export const PING_CHANNEL = 'ping';

export class PingChannel implements IServerChannel {
  async call(_ctx: string, command: string, arg?: any, _token?: CancellationToken): Promise<any> {
    switch (command) {
      case 'ping':
        return 'pong';
      case 'echo':
        return arg;
      default:
        throw new Error(`ping channel: unknown command '${command}'`);
    }
  }

  listen(_ctx: string, event: string, _arg?: any): Event<any> {
    throw new Error(`ping channel: no event '${event}'`);
  }
}

// Typed client-side view of the channel (what the caller uses).
export interface IPingClient {
  ping(): Promise<string>;
  echo<T>(value: T): Promise<T>;
}

export function pingClient(channel: IChannel): IPingClient {
  return {
    ping: () => channel.call('ping'),
    echo: (value) => channel.call('echo', value),
  };
}
