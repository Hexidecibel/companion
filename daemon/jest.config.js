// DAEMON_TEST_SPLIT=portable runs everything except jest.linux-only.js (the Mac mini half of
// bin/test); =linux-only runs just those files (the local half). Unset = the whole suite.
const linuxOnly = require('./jest.linux-only');
const split = process.env.DAEMON_TEST_SPLIT;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const splitPatterns = linuxOnly.map((f) => `<rootDir>/${escapeRe(f)}$`);

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Cap workers so parallel agents do not thrash the box (TEST_WORKERS overrides; uncapped in CI).
  ...(process.env.CI ? {} : { maxWorkers: Number(process.env.TEST_WORKERS ?? 4) }),
  roots: ['<rootDir>/src', '<rootDir>/__tests__'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  ...(split === 'portable' ? { testPathIgnorePatterns: ['/node_modules/', ...splitPatterns] } : {}),
  ...(split === 'linux-only' ? { testRegex: splitPatterns.map((p) => p.replace('<rootDir>/', '')), testMatch: undefined } : {}),
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      // isolatedModules (in tsconfig.jest.json) = transpile only: about 2x faster cold;
      // type errors are caught by `npm run typecheck`, not by jest.
      tsconfig: 'tsconfig.jest.json',
    }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/index.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  clearMocks: true,
  verbose: true,
  testTimeout: 30000,
  forceExit: true,
};
