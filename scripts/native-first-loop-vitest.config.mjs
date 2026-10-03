// Explicit inert source suites only: no env-file loading or application plugins.
const suites = [
  'dispatch-prepared-request', 'prepared-jev', 'prepared-jev-python', 'sample-plate',
  'native-artifact-runtime', 'native-artifact-transport', 'native-artifact-mapping',
  'native-artifact-route', 'native-private-sql', 'native-private-storage',
  'native-stop-transport', 'native-stop-admission', 'native-stop-workflow',
  'native-result-registration', 'native-result-bytes', 'native-result-receipt',
  'native-result-finalization', 'native-result-persistence', 'native-result-reader',
  'native-result-runtime', 'native-first-loop-runtime',
];
export default {
  envDir: false,
  resolve: { alias: { '@': process.cwd() + '/src' } },
  test: { globals: true, environment: 'node',
    include: suites.map(name => `server/engineering/${name}.test.ts`),
    clearMocks: true, mockReset: true, restoreMocks: true },
};
