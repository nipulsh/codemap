import express from 'express';

export function getUsers(_req: unknown, _res: unknown): void {}

const app = express();
const router = express.Router();

app.use('/api', router);
router.get('/users', getUsers);
