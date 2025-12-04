/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.integration.test.ts'],
  verbose: true,
  testTimeout: 30000,
};
