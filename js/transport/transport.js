/**
 * @typedef {object} Transport
 * @property {() => Promise<{ name: string }>} connect
 * @property {() => Promise<void>} disconnect
 * @property {(bytes: Uint8Array) => Promise<void>} write   send one complete frame (transport chunks it)
 * @property {(cb: (chunk: Uint8Array) => void) => void} onData   raw notification chunks, may be fragments
 * @property {(cb: () => void) => void} onDisconnect
 * @property {boolean} connected
 * @property {string} name
 */

export class TransportError extends Error {
  constructor(message, code = 'TRANSPORT') { super(message); this.name = 'TransportError'; this.code = code; }
}
