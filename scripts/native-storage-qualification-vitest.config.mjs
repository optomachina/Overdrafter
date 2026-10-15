// Inert plan suite only: no env-file loading or application plugins.
export default { envDir: false, test: { environment: 'node', include: ['scripts/native-storage-qualification.test.ts'] } };
