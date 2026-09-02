import express from 'express';

export function validate(): void {}
export function authenticateBranch(): void {}
export function audit(): void {}

export function branchHandler(): void {
  validate();
  authenticateBranch();
  audit();
}

const app = express();
app.get('/branch', branchHandler);
