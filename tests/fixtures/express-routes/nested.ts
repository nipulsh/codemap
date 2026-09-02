import express from 'express';

export function getUser(_req: unknown, _res: unknown): void {}

const app = express();
const apiRouter = express.Router();
const userRouter = express.Router();

app.use('/api', apiRouter);
apiRouter.use('/users', userRouter);
userRouter.get('/:id', getUser);
