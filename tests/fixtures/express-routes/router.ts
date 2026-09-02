import express from 'express';

export function getUser(_req: unknown, _res: unknown): void {}

const router = express.Router();

router.get('/users/:id', getUser);
