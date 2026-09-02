import express from 'express';

class UserController {
  list(_req: unknown, _res: unknown): void {}
}

export const userController = new UserController();

const router = express.Router();

router.get('/users', userController.list);
