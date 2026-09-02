import express from 'express';

export function getUsers(_req: unknown, _res: unknown): void {}

const app = express();
const router = express.Router();
const prefix = process.env.API_PREFIX;

app.use(prefix, router);
router.get('/users', getUsers);
