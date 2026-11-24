import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { MlServiceError } from "./mlClient.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid request", details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof MlServiceError) {
    res.status(502).json({ error: "Prediction service unavailable", details: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
