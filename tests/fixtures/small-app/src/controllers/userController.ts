import { findUser } from '../services/userService';

export function handleUserRequest(): void {
  findUser('test@example.com');
}
