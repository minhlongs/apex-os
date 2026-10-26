const TAG = '[ApexOS]';

function prefix(...args: unknown[]): unknown[] {
  return [TAG, ...args];
}

export const info = (...args: unknown[]): void => console.log(...prefix(...args));

export const warn = (...args: unknown[]): void => console.warn(...prefix(...args));

export const error = (...args: unknown[]): void => console.error(...prefix(...args));

export const debug = (...args: unknown[]): void => {
  if (process.env.NODE_ENV !== 'production') {
    console.debug(...prefix(...args));
  }
};

export const success = (...args: unknown[]): void => console.log(...prefix(...args));

const logger = {
  info,
  warn,
  error,
  debug,
  success,
};

export default logger;
