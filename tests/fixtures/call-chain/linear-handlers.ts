import { authenticate } from './linear-auth';

export function loginHandler(): void {
  authenticate();
}
