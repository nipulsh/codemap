import express from 'express';
import { loginHandler } from './linear-handlers';

const app = express();
app.post('/api/login', loginHandler);

export { app };
