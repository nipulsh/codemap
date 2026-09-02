import express from 'express';
import { dynamicHandler } from './dynamic';

const app = express();
app.get('/dynamic', dynamicHandler);
