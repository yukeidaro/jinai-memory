export class RespError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RespError';
  }
}

export function encode(value) {
  if (value === null) return Buffer.from('$-1\r\n');
  if (value instanceof Error) {
    if (/[\r\n]/.test(value.message)) throw new TypeError('Invalid RESP error');
    return Buffer.from(`-${value.message}\r\n`);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from(`*${value.length}\r\n`), ...value.map(encode)]);
  }
  if (typeof value === 'bigint' || Number.isSafeInteger(value)) {
    if (BigInt(value) < -(2n ** 63n) || BigInt(value) >= 2n ** 63n) {
      throw new TypeError('RESP integers must fit in signed 64 bits');
    }
    return Buffer.from(`:${value}\r\n`);
  }
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
    throw new TypeError('RESP values must be strings, buffers, integers, arrays, errors or null');
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from('\r\n')]);
}

export function encodeCommand(args) {
  if (!Array.isArray(args) || args.length === 0) throw new TypeError('Empty command');
  return encode(args.map((arg) => {
    if (Buffer.isBuffer(arg)) return arg;
    if (typeof arg !== 'string' && typeof arg !== 'number' && typeof arg !== 'bigint') {
      throw new TypeError('Invalid command argument');
    }
    return String(arg);
  }));
}

// Array frames and pending bulk lengths survive arbitrary TCP chunk boundaries.
export class RespParser {
  #buffer = Buffer.alloc(0);
  #stack = [];
  #bulkLength = null;

  push(chunk) {
    this.#buffer = this.#buffer.length
      ? Buffer.concat([this.#buffer, chunk])
      : Buffer.from(chunk);
    const replies = [];
    let offset = 0;
    const emit = (value) => {
      while (this.#stack.length) {
        const frame = this.#stack.at(-1);
        frame.values.push(value);
        if (frame.values.length < frame.length) return;
        value = frame.values;
        this.#stack.pop();
      }
      replies.push(value);
    };

    while (offset < this.#buffer.length) {
      if (this.#bulkLength !== null) {
        const end = offset + this.#bulkLength;
        if (this.#buffer.length < end + 2) break;
        if (this.#buffer[end] !== 13 || this.#buffer[end + 1] !== 10) {
          throw new Error('Invalid RESP bulk terminator');
        }
        emit(this.#buffer.toString('utf8', offset, end));
        offset = end + 2;
        this.#bulkLength = null;
        continue;
      }

      const end = this.#buffer.indexOf('\r\n', offset);
      if (end === -1) break;
      const type = this.#buffer[offset];
      const text = this.#buffer.toString('utf8', offset + 1, end);
      offset = end + 2;
      if (/[\r\n]/.test(text)) throw new Error('Invalid RESP header');
      if (type === 43) emit(text);
      else if (type === 45) emit(new RespError(text));
      else if (type === 58) {
        if (!/^[+-]?\d+$/.test(text)) throw new Error('Invalid RESP integer');
        const integer = BigInt(text);
        if (integer < -(2n ** 63n) || integer >= 2n ** 63n) {
          throw new Error('RESP integer exceeds signed 64 bits');
        }
        emit(integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(integer) : integer);
      } else if (type === 36 || type === 42) {
        if (!/^(?:-1|\d+)$/.test(text)) throw new Error('Invalid RESP length');
        const length = Number(text);
        if (!Number.isSafeInteger(length)) throw new Error('Invalid RESP length');
        if (length === -1) emit(null);
        else if (type === 36) this.#bulkLength = length;
        else if (length === 0) emit([]);
        else {
          if (this.#stack.length >= 512) throw new Error('RESP nesting limit exceeded');
          this.#stack.push({ length, values: [] });
        }
      } else {
        throw new Error(`Unsupported RESP type: ${String.fromCharCode(type)}`);
      }
    }
    this.#buffer = this.#buffer.subarray(offset);
    return replies;
  }

  finish() {
    if (this.#buffer.length || this.#stack.length || this.#bulkLength !== null) {
      throw new Error('Truncated RESP reply');
    }
  }
}
