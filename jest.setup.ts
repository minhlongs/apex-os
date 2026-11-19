// Jest setup file
import '@testing-library/jest-dom';
import { TextEncoder, TextDecoder } from 'node:util';
import * as nodeCrypto from 'node:crypto';

// @ts-ignore - adding global polyfills
global.TextEncoder = TextEncoder;
// @ts-ignore - adding global polyfills
global.TextDecoder = TextDecoder;

// Provide randomUUID directly
if (typeof global.crypto?.randomUUID !== 'function') {
  // @ts-ignore - adding global crypto polyfill
  global.crypto = global.crypto || {};
  // @ts-ignore
  global.crypto.randomUUID = nodeCrypto.randomUUID;
}

// Provide getRandomValues if missing
if (typeof global.crypto?.getRandomValues !== 'function') {
  // @ts-ignore
  global.crypto.getRandomValues = (arr: Uint8Array) => {
    const bytes = nodeCrypto.randomBytes(arr.length);
    for (let i = 0; i < arr.length; i++) {
      arr[i] = bytes[i];
    }
    return arr;
  };
}

// Provide subtle crypto for WebCrypto HMAC operations
if (!global.crypto?.subtle && nodeCrypto.webcrypto?.subtle) {
  // @ts-ignore
  global.crypto.subtle = nodeCrypto.webcrypto.subtle;
}

// Mock NextResponse properly
class MockNextResponse {
  static json(data: any, init?: { status?: number; headers?: Record<string, string> }) {
    const response = new MockNextResponse();
    response._body = JSON.stringify(data);
    response._status = init?.status ?? 200;
    if (init?.headers) {
      response._headers = init.headers;
    }
    return response;
  }

  private _body: string = '{}';
  private _status: number = 200;
  private _headers: Map<string, string> = new Map();

  async json() {
    return JSON.parse(this._body);
  }

  get status() {
    return this._status;
  }

  get headers() {
    return {
      get: (name: string) => this._headers.get(name) || null,
      set: (name: string, value: string) => this._headers.set(name, value),
    };
  }
}

// @ts-ignore - mocking NextResponse
global.NextResponse = MockNextResponse;

// Mock Web APIs that Next.js Request/Response depend on
// @ts-ignore - mocking global Web API for Jest tests
global.Headers = class Headers {
  private _map: Map<string, string> = new Map();

  constructor(init?: any) {
    if (init) {
      if (init instanceof Headers || (init && typeof init.forEach === 'function')) {
        init.forEach((value: string, key: string) => this.set(key, value));
      } else if (Array.isArray(init)) {
        init.forEach(([k, v]) => this.set(k, v));
      } else if (typeof init === 'object') {
        Object.entries(init).forEach(([k, v]) => this.set(k, v as string));
      }
    }
  }

  get(name: string): string | null {
    return this._map.get(name.toLowerCase()) ?? null;
  }

  set(name: string, value: string): void {
    this._map.set(name.toLowerCase(), String(value));
  }

  append(name: string, value: string): void {
    const key = name.toLowerCase();
    const existing = this._map.get(key);
    this._map.set(key, existing ? `${existing}, ${value}` : String(value));
  }

  has(name: string): boolean {
    return this._map.has(name.toLowerCase());
  }

  delete(name: string): boolean {
    return this._map.delete(name.toLowerCase());
  }

  forEach(cb: (value: string, key: string, parent: Headers) => void): void {
    this._map.forEach((value, key) => cb(value, key, this as any));
  }

  entries() {
    return this._map.entries();
  }

  keys() {
    return this._map.keys();
  }

  values() {
    return this._map.values();
  }

  [Symbol.iterator]() {
    return this._map.entries();
  }
} as any;

// @ts-ignore - mocking global Web API for Jest tests
global.Request = class Request {
  private _url: string;
  public headers: any;
  public method: string;
  private _body: any;

  constructor(input: any, init?: any) {
    if (typeof input === 'string') {
      this._url = input;
    } else if (input instanceof URL) {
      this._url = input.toString();
    } else if (input && typeof input === 'object' && input.url) {
      this._url = input.url;
    } else {
      this._url = String(input);
    }

    this.method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    this.headers = new (global.Headers as any)(init?.headers ?? input?.headers);
    this._body = init?.body ?? input?.body ?? null;
  }

  get url(): string {
    return this._url;
  }

  // A real Request body is a single-use stream: once consumed, a second read
  // returns ''. The mock must enforce that, otherwise a route that reads the
  // body twice appears to work here while failing in production.
  private _bodyUsed = false;

  async json() {
    if (this._bodyUsed) {
      throw new TypeError('Body is unusable: body has already been read');
    }
    this._bodyUsed = true;
    if (typeof this._body === 'string') {
      return JSON.parse(this._body);
    }
    return this._body ?? {};
  }

  async text() {
    if (this._bodyUsed) {
      throw new TypeError('Body is unusable: body has already been read');
    }
    this._bodyUsed = true;
    if (typeof this._body === 'string') {
      return this._body;
    }
    return this._body != null ? JSON.stringify(this._body) : '';
  }
} as any;

// @ts-ignore - mocking global Web API for Jest tests
global.Response = class Response {
  public status: number;
  public headers: any;

  constructor(public body?: any, public init?: any) {
    this.status = init?.status ?? 200;
    this.headers = new (global.Headers as any)(init?.headers);
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  async json() {
    if (typeof this.body === 'string') {
      return JSON.parse(this.body);
    }
    return this.body ?? {};
  }

  async text() {
    if (typeof this.body === 'string') {
      return this.body;
    }
    return this.body != null ? JSON.stringify(this.body) : '';
  }

  static json(data: any, init?: any) {
    const body = JSON.stringify(data);
    const headers = new (global.Headers as any)(init?.headers);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return new Response(body, { ...init, headers });
  }
} as any;

// Mock Sentry to prevent actual network calls during tests
const mockSentry = {
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  setUserContext: jest.fn(),
  startSpan: jest.fn((_options, callback) => callback({})),
  getCurrentScope: jest.fn(() => ({
    getSpan: jest.fn(() => ({ spanId: 'test-span-id' })),
  })),
  withScope: jest.fn((callback) => callback({})),
  browserTracingIntegration: jest.fn(() => ({})),
  replayIntegration: jest.fn(() => ({})),
};

jest.mock('@sentry/nextjs', () => mockSentry);

// Mock environment variables
process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://test@o0.ingest.sentry.io/0';
process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'false';
process.env.SENTRY_ORG = 'test-org';
process.env.SENTRY_PROJECT = 'test-project';
process.env.SENTRY_ENVIRONMENT = 'test';
