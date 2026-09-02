import type { NextFunction, Request, Response } from 'express';
import { getUser } from './service.ts';

export async function getUserController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = await getUser(String(req.params.id));
    res.status(200).json(user);
  } catch (error) {
    next(error);
  }
}

export function errorController(_req: Request, _res: Response) {
  throw new Error('boom');
}
