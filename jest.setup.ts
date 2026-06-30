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
global.Request = class Request {
  private _url: string;

  constructor(input: RequestInfo | URL, public init?: RequestInit) {
    if (typeof input === 'string') {
      this._url = input;
    } else if (input instanceof URL) {
      this._url = input.toString();
    } else {
      this._url = String(input);
    }
  }

  get url(): string {
    return this._url;
  }
};

// @ts-ignore - mocking global Web API for Jest tests
global.Response = class Response {
  constructor(public body?: BodyInit, public init?: ResponseInit) {}
  json() {
    return Promise.resolve(JSON.parse(JSON.stringify(this.body || '{}')));
  }
};

// @ts-ignore - mocking global Web API for Jest tests
global.Headers = class Headers extends Map<string, string> {
  constructor(public init?: HeadersInit) {
    super();
    if (init) {
      Object.entries(init).forEach(([key, value]) => this.set(key, value as string));
    }
  }
};

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
