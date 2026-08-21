import { sendRetirementProblem } from './_lib/retirement.js';

export default function handler(req, res) {
  return sendRetirementProblem({
    req,
    res,
    path: req?.query?.path || req?.url || '/'
  });
}
