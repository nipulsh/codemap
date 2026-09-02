import { withCodeMapSpan } from '../../../src/runtime/instrumentation/instrumentation.ts';
import { findUser } from './repository.ts';

const SERVICE_SYMBOL = 'symbol:/proj/service.ts:Function:getUser';

export async function getUser(id: string) {
  return withCodeMapSpan(
    'UserService.getUser',
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return findUser(id);
    },
    {
      symbolId: SERVICE_SYMBOL,
      functionName: 'getUser',
      filePath: '/proj/service.ts',
      line: 12,
    },
  );
}
