import { withCodeMapSpanSync } from '../../../src/runtime/instrumentation/instrumentation.ts';

export function findUser(id: string) {
  return withCodeMapSpanSync(
    'UserRepository.findUser',
    () => ({ id, name: `user-${id}` }),
    {
      functionName: 'findUser',
      filePath: '/proj/repository.ts',
      line: 8,
    },
  );
}
