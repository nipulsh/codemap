import express from 'express';
import { externalHandler } from './external';

const app = express();
app.get('/external', externalHandler);
