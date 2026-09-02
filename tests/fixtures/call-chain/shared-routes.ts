import express from 'express';
import { sharedHandler } from './shared-handler';

const app = express();

app.get('/a', sharedHandler);
app.get('/b', sharedHandler);
