import express from 'express';

export function getUsers(_req: unknown, _res: unknown): void {}
export function createUser(_req: unknown, _res: unknown): void {}

const app = express();

app.get('/users', getUsers);
app.post('/users', createUser);
